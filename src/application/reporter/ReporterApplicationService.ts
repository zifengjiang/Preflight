import { AgentEvent } from "../../domain/event/AgentEvent.js";
import type { EventRepository } from "../../domain/repositories/index.js";
import type { LiveDebugForegroundApp } from "../../domain/runtime/interfaces.js";
import { nowIso } from "../../shared-kernel/time/index.js";
import { EventType } from "../../shared-kernel/enums/index.js";

export interface EventPublisher {
  publish(event: AgentEvent): Promise<void>;
  publishLiveDebugFrame?(
    event: AgentEvent,
    frame: {
      mimeType: string;
      data: Buffer;
      capturedAt: string;
      sessionId: string;
      resourceId: string;
      foregroundApp?: LiveDebugForegroundApp;
    },
  ): Promise<void>;
}

export class ReporterApplicationService {
  constructor(
    private readonly eventRepository: EventRepository,
    private readonly publisher: EventPublisher,
  ) {}

  async emit(type: EventType, payload: Record<string, unknown>): Promise<void> {
    const event = new AgentEvent(type, nowIso(), payload);
    await this.eventRepository.append(event);
    await this.publisher.publish(event);
  }

  async emitLiveDebugFrame(payload: {
    sessionId: string;
    resourceId: string;
    mimeType: string;
    dataBase64: string;
    sourceUri?: string;
    capturedAt?: string;
    foregroundApp?: LiveDebugForegroundApp;
  }): Promise<void> {
    const capturedAt = payload.capturedAt ?? nowIso();
    const frameData = Buffer.from(payload.dataBase64, "base64");
    const event = new AgentEvent(EventType.LIVE_DEBUG_FRAME, nowIso(), {
      sessionId: payload.sessionId,
      resourceId: payload.resourceId,
      mimeType: payload.mimeType,
      capturedAt,
      byteLength: frameData.byteLength,
      sourceUri: payload.sourceUri ?? "",
      ...(payload.foregroundApp ? { foregroundApp: payload.foregroundApp } : {}),
    });
    await this.eventRepository.append(event);
    await this.publisher.publish(event);
    if (this.publisher.publishLiveDebugFrame) {
      await this.publisher.publishLiveDebugFrame(event, {
        mimeType: payload.mimeType,
        data: frameData,
        capturedAt,
        sessionId: payload.sessionId,
        resourceId: payload.resourceId,
        ...(payload.foregroundApp ? { foregroundApp: payload.foregroundApp } : {}),
      });
    }
  }
}
