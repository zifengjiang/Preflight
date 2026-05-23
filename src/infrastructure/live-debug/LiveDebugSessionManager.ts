import type { LiveDebugForegroundApp } from "../../domain/runtime/interfaces.js";

type LiveInputAction =
  | { action: "tap"; x: number; y: number; coordinateSpace?: "image"; sourceWidth?: number; sourceHeight?: number }
  | {
      action: "swipe";
      x: number;
      y: number;
      x2: number;
      y2: number;
      durationMs?: number;
      coordinateSpace?: "image";
      sourceWidth?: number;
      sourceHeight?: number;
    }
  | { action: "key"; key: string };

type LiveFrame = {
  mimeType: string;
  dataBase64: string;
  sourceUri: string;
  foregroundApp?: LiveDebugForegroundApp;
};

export interface LiveDebugFrameSource {
  capture(resourceId: string): Promise<LiveFrame>;
}

export interface LiveDebugInputInjector {
  send(resourceId: string, input: LiveInputAction): Promise<{ output: string }>;
}

export interface StartLiveDebugSessionParams {
  sessionId: string;
  resourceId: string;
  frameIntervalMs?: number;
  onFrame: (frame: LiveFrame) => Promise<void>;
  onState: (status: "STARTED" | "STOPPED" | "FAILED", message?: string) => Promise<void>;
}

type ActiveLiveSession = {
  sessionId: string;
  resourceId: string;
  frameIntervalMs: number;
  timer: NodeJS.Timeout;
  pumping: boolean;
  onFrame: (frame: LiveFrame) => Promise<void>;
  onState: (status: "STARTED" | "STOPPED" | "FAILED", message?: string) => Promise<void>;
};

const DEFAULT_FRAME_INTERVAL_MS = 1000;
const MIN_FRAME_INTERVAL_MS = 1;

export class LiveDebugSessionManager {
  private readonly sessions = new Map<string, ActiveLiveSession>();

  constructor(
    private readonly frameSource: LiveDebugFrameSource,
    private readonly inputInjector: LiveDebugInputInjector,
  ) {}

  async start(params: StartLiveDebugSessionParams): Promise<void> {
    await this.stop(params.sessionId);
    const frameIntervalMs = this.normalizeFrameInterval(params.frameIntervalMs);

    const session: ActiveLiveSession = {
      sessionId: params.sessionId,
      resourceId: params.resourceId,
      frameIntervalMs,
      pumping: false,
      timer: setInterval(() => {
        void this.tick(params.sessionId);
      }, frameIntervalMs),
      onFrame: params.onFrame,
      onState: params.onState,
    };
    this.sessions.set(params.sessionId, session);
    await session.onState("STARTED");
    await this.tick(params.sessionId);
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    clearInterval(session.timer);
    this.sessions.delete(sessionId);
    await session.onState("STOPPED");
  }

  async sendInput(sessionId: string, input: LiveInputAction): Promise<{ output: string; resourceId: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`live debug session not found: ${sessionId}`);
    }
    const result = await this.inputInjector.send(session.resourceId, input);
    return { output: result.output, resourceId: session.resourceId };
  }

  private normalizeFrameInterval(frameIntervalMs?: number): number {
    if (!Number.isFinite(frameIntervalMs) || (frameIntervalMs ?? 0) <= 0) {
      return DEFAULT_FRAME_INTERVAL_MS;
    }
    return Math.max(MIN_FRAME_INTERVAL_MS, Math.floor(frameIntervalMs!));
  }

  private async tick(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.pumping) return;
    session.pumping = true;
    try {
      const frame = await this.frameSource.capture(session.resourceId);
      await session.onFrame(frame);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await session.onState("FAILED", message);
      } catch (reportError) {
        const reportMessage = reportError instanceof Error ? reportError.message : String(reportError);
        console.error(
          `[LiveDebugSessionManager] tick failed and could not emit FAILED state: original=${message}; report=${reportMessage}`,
        );
      }
    } finally {
      session.pumping = false;
    }
  }
}

export type { LiveInputAction, LiveFrame };
