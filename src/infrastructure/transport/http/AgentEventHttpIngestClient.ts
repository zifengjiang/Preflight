import type { AgentEvent } from "../../../domain/event/AgentEvent.js";

export interface AgentEventHttpIngestClientOptions {
  baseUrl?: string;
  agentId: string;
  authToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * WS 不可用时的 Agent 事件 HTTP 投递（与 WS 文本帧同构 JSON）。
 * 实况调试二进制帧不走此通道，仍仅通过 {@link WsEventPublisher}。
 */
export class AgentEventHttpIngestClient {
  private readonly base?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: AgentEventHttpIngestClientOptions) {
    this.base = opts.baseUrl?.trim() || undefined;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    const t = opts.timeoutMs;
    this.timeoutMs = t != null && Number.isFinite(t) && t > 0 ? t : 12_000;
  }

  isEnabled(): boolean {
    return !!this.base;
  }

  async postEvent(event: AgentEvent): Promise<void> {
    if (!this.base) return;
    const url = `${this.base.replace(/\/+$/, "")}/api/agents/${encodeURIComponent(this.opts.agentId)}/events`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (this.opts.authToken) headers.Authorization = `Bearer ${this.opts.authToken}`;
    const body = JSON.stringify({
      type: event.type,
      timestamp: event.timestamp,
      payload: event.payload,
    });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const resp = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: ac.signal,
      });
      if (!resp.ok) {
        throw new Error(`event ingest HTTP ${resp.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
