import type { AgentEvent } from "../../../domain/event/AgentEvent.js";
import type { LiveDebugForegroundApp } from "../../../domain/runtime/interfaces.js";
import type { EventPublisher } from "../../../application/reporter/ReporterApplicationService.js";
import type { AgentEventHttpIngestClient } from "../http/AgentEventHttpIngestClient.js";
import type { WsClient } from "./WsClient.js";
import type { WsEventPublisher } from "./WsEventPublisher.js";

/**
 * WS 连通时仅走 WS；断开且配置了 HTTP ingest 时优先 POST，失败再回落到 WS 待发队列。
 */
export class ResilientWsOrHttpEventPublisher implements EventPublisher {
  constructor(
    private readonly wsClient: WsClient,
    private readonly inner: WsEventPublisher,
    private readonly httpIngest: AgentEventHttpIngestClient,
  ) {}

  async publish(event: AgentEvent): Promise<void> {
    if (this.httpIngest.isEnabled() && !this.wsClient.isOpen()) {
      try {
        await this.httpIngest.postEvent(event);
        return;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(`[ResilientWsOrHttpEventPublisher] HTTP ingest failed: ${msg}; buffering via WS`);
      }
    }
    await this.inner.publish(event);
  }

  async publishLiveDebugFrame(
    event: AgentEvent,
    frame: {
      mimeType: string;
      data: Buffer;
      capturedAt: string;
      sessionId: string;
      resourceId: string;
      foregroundApp?: LiveDebugForegroundApp;
    },
  ): Promise<void> {
    await this.inner.publishLiveDebugFrame(event, frame);
  }
}
