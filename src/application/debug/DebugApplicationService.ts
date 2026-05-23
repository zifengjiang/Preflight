import type { LeaseApplicationService } from "../lease/LeaseApplicationService.js";
import type { ReporterApplicationService } from "../reporter/ReporterApplicationService.js";
import type { SessionApplicationService } from "../session/SessionApplicationService.js";
import type { DebugRuntime } from "../../domain/runtime/interfaces.js";
import { ArtifactType, EventType, OwnerType, SessionStatus } from "../../shared-kernel/enums/index.js";
import { asResourceId, asSessionId, type SessionId } from "../../shared-kernel/ids/index.js";
import { LiveDebugSessionManager, type LiveInputAction } from "../../infrastructure/live-debug/LiveDebugSessionManager.js";
import {
  RuntimeLiveDebugFrameSource,
  RuntimeLiveDebugInputInjector,
} from "../../infrastructure/live-debug/RuntimeLiveDebugAdapters.js";

export class DebugApplicationService {
  private readonly liveSessionManager: LiveDebugSessionManager;

  constructor(
    private readonly leaseService: LeaseApplicationService,
    private readonly sessionService: SessionApplicationService,
    private readonly debugRuntime: DebugRuntime,
    private readonly reporter: ReporterApplicationService,
  ) {
    this.liveSessionManager = new LiveDebugSessionManager(
      new RuntimeLiveDebugFrameSource(this.debugRuntime),
      new RuntimeLiveDebugInputInjector(this.debugRuntime),
    );
  }

  async createDebugSession(params: {
    sessionId: string;
    resourceId: string;
    leaseId: string;
    ownerId: string;
  }): Promise<void> {
    await this.leaseService.ensureActive(asResourceId(params.resourceId));
    const session = await this.sessionService.createDebug(
      params.sessionId,
      params.resourceId,
      params.leaseId,
      params.ownerId,
      OwnerType.DEBUG_CLIENT,
    );
    await this.reporter.emit(EventType.SESSION_CHANGED, { sessionId: session.id, status: session.status });
  }

  async sendCommand(sessionId: string, command: string): Promise<string> {
    const session = await this.sessionService.getDebug(asSessionId(sessionId));
    if (!session) {
      throw new Error(`debug session not found: ${sessionId}`);
    }
    await this.leaseService.ensureActive(session.resourceId);
    const result = await this.debugRuntime.runCommand(session.resourceId, command);
    await this.reporter.emit(EventType.SESSION_CHANGED, { sessionId, status: SessionStatus.RUNNING });
    return result.output;
  }

  async snapshot(sessionId: string): Promise<string> {
    const session = await this.sessionService.getDebug(asSessionId(sessionId));
    if (!session) {
      throw new Error(`debug session not found: ${sessionId}`);
    }
    await this.leaseService.ensureActive(session.resourceId);
    const shot = await this.debugRuntime.snapshot(session.resourceId);
    await this.reporter.emit(EventType.ARTIFACT_READY, {
      taskId: `debug-${sessionId}`,
      artifactId: `snapshot-${sessionId}`,
      artifactType: ArtifactType.SCREENSHOT,
      uri: shot.uri,
    });
    return shot.uri;
  }

  async close(sessionId: SessionId): Promise<void> {
    await this.liveSessionManager.stop(String(sessionId));
    const closed = await this.sessionService.closeDebug(asSessionId(sessionId));
    if (!closed) return;
    await this.reporter.emit(EventType.SESSION_CHANGED, { sessionId: closed.id, status: closed.status });
  }

  async startLiveSession(params: { sessionId: string; resourceId?: string; frameIntervalMs?: number }): Promise<void> {
    const session = await this.sessionService.getDebug(asSessionId(params.sessionId));
    if (!session) {
      throw new Error(`debug session not found: ${params.sessionId}`);
    }
    const resourceId = params.resourceId ? asResourceId(params.resourceId) : session.resourceId;
    await this.leaseService.ensureActive(resourceId);
    await this.liveSessionManager.start({
      sessionId: params.sessionId,
      resourceId,
      frameIntervalMs: params.frameIntervalMs,
      onState: async (status, message) => {
        await this.reporter.emit(EventType.LIVE_DEBUG_SESSION_CHANGED, {
          sessionId: params.sessionId,
          resourceId,
          status,
          ...(message ? { message } : {}),
        });
      },
      onFrame: async (frame) => {
        await this.reporter.emitLiveDebugFrame({
          sessionId: params.sessionId,
          resourceId,
          mimeType: frame.mimeType,
          dataBase64: frame.dataBase64,
          sourceUri: frame.sourceUri,
          capturedAt: new Date().toISOString(),
          ...(frame.foregroundApp ? { foregroundApp: frame.foregroundApp } : {}),
        });
      },
    });
  }

  async stopLiveSession(sessionId: string): Promise<void> {
    await this.liveSessionManager.stop(sessionId);
  }

  async sendLiveInput(sessionId: string, input: LiveInputAction): Promise<void> {
    const session = await this.sessionService.getDebug(asSessionId(sessionId));
    if (!session) {
      throw new Error(`debug session not found: ${sessionId}`);
    }
    await this.leaseService.ensureActive(session.resourceId);
    try {
      const result = await this.liveSessionManager.sendInput(sessionId, input);
      await this.reporter.emit(EventType.LIVE_DEBUG_INPUT_ACK, {
        sessionId,
        resourceId: result.resourceId,
        ok: true,
        action: input.action,
        message: result.output,
      });
    } catch (error) {
      await this.reporter.emit(EventType.LIVE_DEBUG_INPUT_ACK, {
        sessionId,
        resourceId: session.resourceId,
        ok: false,
        action: input.action,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
