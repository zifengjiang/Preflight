import WebSocket from "ws";

function isBrokenPipeError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
  return code === "EPIPE" || code === "ECONNRESET" || code === "EHOSTUNREACH" || code === "ETIMEDOUT";
}

export type WsConnectionState = "connecting" | "open" | "disconnected";

export interface WsClientOptions {
  endpoint: string;
  heartbeatMs: number;
  /** 兼容旧字段：作为退避下限的别名，当未设置 reconnectBackoffMinMs 时使用 */
  reconnectMs: number;
  reconnectBackoffMinMs?: number;
  reconnectBackoffMaxMs?: number;
  pendingQueueMaxItems?: number;
  authToken?: string;
  onOpen?: () => void;
  onConnectionState?: (state: WsConnectionState) => void;
  /** 待发队列深度变化（含因上限丢弃后） */
  onPendingDepth?: (depth: number) => void;
  onReconnectScheduled?: (delayMs: number, attempt: number) => void;
  onPendingDropped?: (droppedCount: number) => void;
}

export class WsClient {
  private socket: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private messageHandlers: Array<(data: string) => Promise<void>> = [];
  private pendingSends: Array<string | Buffer> = [];
  private reconnectAttempt = 0;
  private state: WsConnectionState = "disconnected";

  constructor(private readonly options: WsClientOptions) {}

  getConnectionState(): WsConnectionState {
    return this.state;
  }

  isOpen(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  getPendingSendDepth(): number {
    return this.pendingSends.length;
  }

  getReconnectAttempt(): number {
    return this.reconnectAttempt;
  }

  private setState(next: WsConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.options.onConnectionState?.(next);
  }

  onMessage(handler: (data: string) => Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  connect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      try {
        this.socket.removeAllListeners();
        this.socket.close();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }

    this.setState("connecting");
    this.socket = new WebSocket(this.options.endpoint, {
      ...(this.options.authToken
        ? { headers: { Authorization: `Bearer ${this.options.authToken}` } }
        : {}),
    });
    this.socket.on("open", () => {
      this.reconnectAttempt = 0;
      this.setState("open");
      this.startHeartbeat();
      void this.flushPending();
      this.options.onOpen?.();
    });
    this.socket.on("message", async (data) => {
      const text = data.toString();
      for (const handler of this.messageHandlers) {
        await handler(text);
      }
    });
    this.socket.on("close", () => this.scheduleReconnect());
    this.socket.on("error", () => this.scheduleReconnect());
  }

  /**
   * 发往平台 WS；对端已断开时常见 EPIPE/ECONNRESET。
   * 此处永不 reject，避免业务层未捕获导致进程退出；失败时入队并关闭连接以触发重连。
   */
  async send(data: string | Buffer): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.pendingSends.push(data);
      this.enforcePendingLimit();
      this.options.onPendingDepth?.(this.pendingSends.length);
      return;
    }
    const sock = this.socket;
    await new Promise<void>((resolve) => {
      sock.send(data, (error) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code ?? "";
          const hint = isBrokenPipeError(error) ? " (peer likely closed connection)" : "";
          console.warn(`[WsClient] send failed code=${code}${hint}: ${error.message}`);
          this.pendingSends.unshift(data);
          this.enforcePendingLimit();
          this.options.onPendingDepth?.(this.pendingSends.length);
          try {
            sock.close();
          } catch {
            try {
              sock.terminate();
            } catch {
              /* ignore */
            }
          }
          resolve();
          return;
        }
        resolve();
      });
    });
  }

  private enforcePendingLimit(): void {
    const max = this.options.pendingQueueMaxItems ?? 10_000;
    if (max <= 0 || this.pendingSends.length <= max) return;
    let dropped = 0;
    while (this.pendingSends.length > max) {
      this.pendingSends.shift();
      dropped += 1;
    }
    if (dropped > 0) {
      console.warn(`[WsClient] dropped ${dropped} pending send(s), maxQueue=${max}`);
      this.options.onPendingDropped?.(dropped);
    }
  }

  private async flushPending(): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const queue = [...this.pendingSends];
    this.pendingSends = [];
    this.options.onPendingDepth?.(0);
    for (const data of queue) {
      await this.send(data);
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        this.socket.ping();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[WsClient] ping failed: ${message}`);
      }
    }, this.options.heartbeatMs);
  }

  private backoffDelayMs(): number {
    const min =
      this.options.reconnectBackoffMinMs ??
      (Number.isFinite(this.options.reconnectMs) && this.options.reconnectMs > 0 ? this.options.reconnectMs : 2000);
    const maxCap = this.options.reconnectBackoffMaxMs ?? Math.max(min * 16, 60_000);
    const exp = min * Math.pow(2, this.reconnectAttempt);
    const capped = Math.min(maxCap, exp);
    const jitter = Math.floor(Math.random() * Math.min(capped * 0.2, 5000));
    return Math.min(maxCap, capped + jitter);
  }

  private scheduleReconnect(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // close / error / send 失败可能连续触发，合并为一次退避，避免 reconnectAttempt 连加
    if (this.reconnectTimer) {
      return;
    }
    this.setState("disconnected");
    this.reconnectAttempt += 1;
    const delayMs = this.backoffDelayMs();
    this.options.onReconnectScheduled?.(delayMs, this.reconnectAttempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }
}
