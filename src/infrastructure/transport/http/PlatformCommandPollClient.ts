import type { PlatformToAgentCommand } from "../../../protocol-contracts/commands/index.js";

export interface PlatformCommandPollClientOptions {
  /** 例如 https://platform.example.com 或 http://127.0.0.1:9090 */
  baseUrl?: string;
  agentId: string;
  authToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface PendingCommandItem {
  deliveryId: string;
  issuedAt?: string;
  command: PlatformToAgentCommand;
}

export class PlatformCommandPollClient {
  private readonly base?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: PlatformCommandPollClientOptions) {
    this.base = opts.baseUrl?.trim() || undefined;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    const t = opts.timeoutMs;
    this.timeoutMs = t != null && Number.isFinite(t) && t > 0 ? t : 15_000;
  }

  isEnabled(): boolean {
    return !!this.base;
  }

  private url(path: string): string {
    return `${this.base!.replace(/\/+$/, "")}${path}`;
  }

  async fetchPending(limit: number): Promise<PendingCommandItem[]> {
    if (!this.base) return [];
    const lim = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
    const path = `/api/agents/${encodeURIComponent(this.opts.agentId)}/commands/pending?limit=${lim}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.opts.authToken) headers.Authorization = `Bearer ${this.opts.authToken}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const resp = await this.fetchImpl(this.url(path), {
        method: "GET",
        headers,
        signal: ac.signal,
      });
      if (!resp.ok) {
        throw new Error(`poll pending failed: ${resp.status}`);
      }
      const body = (await resp.json()) as { items?: unknown };
      const items = Array.isArray(body.items) ? body.items : [];
      const out: PendingCommandItem[] = [];
      for (const row of items) {
        if (!row || typeof row !== "object") continue;
        const r = row as Record<string, unknown>;
        const deliveryId = typeof r.deliveryId === "string" ? r.deliveryId.trim() : "";
        const cmd = r.command;
        if (!deliveryId || !cmd || typeof cmd !== "object" || typeof (cmd as { type?: unknown }).type !== "string") {
          continue;
        }
        out.push({
          deliveryId,
          issuedAt: typeof r.issuedAt === "string" ? r.issuedAt : undefined,
          command: cmd as PlatformToAgentCommand,
        });
      }
      return out;
    } finally {
      clearTimeout(timer);
    }
  }

  async ack(deliveryIds: string[]): Promise<void> {
    if (!this.base || deliveryIds.length === 0) return;
    const path = `/api/agents/${encodeURIComponent(this.opts.agentId)}/commands/ack`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (this.opts.authToken) headers.Authorization = `Bearer ${this.opts.authToken}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const resp = await this.fetchImpl(this.url(path), {
        method: "POST",
        headers,
        body: JSON.stringify({ deliveryIds }),
        signal: ac.signal,
      });
      if (!resp.ok) {
        throw new Error(`ack failed: ${resp.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
