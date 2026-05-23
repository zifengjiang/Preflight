import type { DebugRuntime, LiveDebugForegroundApp } from "../../domain/runtime/interfaces.js";
import { asResourceId } from "../../shared-kernel/ids/index.js";
import type {
  LiveDebugFrameSource,
  LiveDebugInputInjector,
  LiveInputAction,
} from "./LiveDebugSessionManager.js";

export class RuntimeLiveDebugFrameSource implements LiveDebugFrameSource {
  constructor(private readonly runtime: DebugRuntime) {}

  async capture(resourceId: string): Promise<{
    mimeType: string;
    dataBase64: string;
    sourceUri: string;
    foregroundApp?: LiveDebugForegroundApp;
  }> {
    return this.runtime.captureLiveFrame(asResourceId(resourceId));
  }
}

export class RuntimeLiveDebugInputInjector implements LiveDebugInputInjector {
  constructor(private readonly runtime: DebugRuntime) {}

  async send(resourceId: string, input: LiveInputAction): Promise<{ output: string }> {
    return this.runtime.sendLiveInput(asResourceId(resourceId), input);
  }
}
