import type { AgentEvent } from "../../../domain/event/AgentEvent.js";
import type { LiveDebugForegroundApp } from "../../../domain/runtime/interfaces.js";
import type { EventPublisher } from "../../../application/reporter/ReporterApplicationService.js";
import { WsClient } from "./WsClient.js";

const LIVE_DEBUG_BINARY_MAGIC = "LDBG1";

function encodeLiveDebugBinaryPacket(params: {
  sessionId: string;
  resourceId: string;
  mimeType: string;
  capturedAt: string;
  data: Buffer;
  foregroundApp?: LiveDebugForegroundApp;
}): Buffer {
  const header = Buffer.from(
    JSON.stringify({
      kind: "LiveDebugFrameBinary",
      sessionId: params.sessionId,
      resourceId: params.resourceId,
      mimeType: params.mimeType,
      capturedAt: params.capturedAt,
      byteLength: params.data.byteLength,
      ...(params.foregroundApp ? { foregroundApp: params.foregroundApp } : {}),
    }),
    "utf8",
  );
  const magic = Buffer.from(LIVE_DEBUG_BINARY_MAGIC, "utf8");
  const headerLength = Buffer.allocUnsafe(4);
  headerLength.writeUInt32BE(header.byteLength, 0);
  return Buffer.concat([magic, headerLength, header, params.data]);
}

export class WsEventPublisher implements EventPublisher {
  constructor(private readonly wsClient: WsClient) {}

  async publish(event: AgentEvent): Promise<void> {
    await this.wsClient.send(JSON.stringify(event));
  }

  async publishLiveDebugFrame(
    _event: AgentEvent,
    frame: {
      mimeType: string;
      data: Buffer;
      capturedAt: string;
      sessionId: string;
      resourceId: string;
      foregroundApp?: LiveDebugForegroundApp;
    },
  ): Promise<void> {
    const packet = encodeLiveDebugBinaryPacket({
      sessionId: frame.sessionId,
      resourceId: frame.resourceId,
      mimeType: frame.mimeType,
      capturedAt: frame.capturedAt,
      data: frame.data,
      ...(frame.foregroundApp ? { foregroundApp: frame.foregroundApp } : {}),
    });
    await this.wsClient.send(packet);
  }
}
