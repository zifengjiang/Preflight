import type { WsConnectionState } from "../../infrastructure/transport/ws/WsClient.js";

export interface HealthSnapshot {
  healthy: boolean;
  heartbeats: number;
  wsConnected: boolean;
  wsConnectionState: WsConnectionState;
  wsReconnectCount: number;
  wsLastReconnectDelayMs: number | null;
  wsPendingDroppedTotal: number;
  pendingSendQueueDepth: number;
  pollLastOkAt: string | null;
  pollLastErrorAt: string | null;
}

export class HealthMetricsService {
  private heartbeats = 0;
  private wsReconnectCount = 0;
  private wsLastReconnectDelayMs: number | null = null;
  private wsPendingDroppedTotal = 0;
  private wsConnectionState: WsConnectionState = "disconnected";
  private pendingSendQueueDepth = 0;
  private pollLastOkAt: string | null = null;
  private pollLastErrorAt: string | null = null;

  markHeartbeat(): void {
    this.heartbeats += 1;
  }

  setWsConnectionState(state: WsConnectionState): void {
    this.wsConnectionState = state;
  }

  setPendingSendDepth(depth: number): void {
    this.pendingSendQueueDepth = depth;
  }

  onReconnectScheduled(delayMs: number): void {
    this.wsReconnectCount += 1;
    this.wsLastReconnectDelayMs = delayMs;
  }

  onPendingDropped(count: number): void {
    this.wsPendingDroppedTotal += count;
  }

  markPollOk(): void {
    this.pollLastOkAt = new Date().toISOString();
    this.pollLastErrorAt = null;
  }

  markPollError(): void {
    this.pollLastErrorAt = new Date().toISOString();
  }

  snapshot(): HealthSnapshot {
    return {
      healthy: true,
      heartbeats: this.heartbeats,
      wsConnected: this.wsConnectionState === "open",
      wsConnectionState: this.wsConnectionState,
      wsReconnectCount: this.wsReconnectCount,
      wsLastReconnectDelayMs: this.wsLastReconnectDelayMs,
      wsPendingDroppedTotal: this.wsPendingDroppedTotal,
      pendingSendQueueDepth: this.pendingSendQueueDepth,
      pollLastOkAt: this.pollLastOkAt,
      pollLastErrorAt: this.pollLastErrorAt,
    };
  }
}
