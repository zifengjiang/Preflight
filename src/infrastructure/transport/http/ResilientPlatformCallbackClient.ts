import { CallbackOutboxStore } from "./CallbackOutboxStore.js";
import {
  isCallbackNotFoundError,
  PlatformCallbackClient,
  type TaskLogCallbackPayload,
  type TaskReportCallbackPayload,
} from "./PlatformCallbackClient.js";

/**
 * HTTP 回调：主地址失败时可尝试备用地址；仍失败则落盘，可在网络恢复后 {@link flushOutbox} 重放。
 */
export class ResilientPlatformCallbackClient {
  constructor(
    private readonly inner: PlatformCallbackClient,
    private readonly fallback: PlatformCallbackClient | undefined,
    private readonly outbox: CallbackOutboxStore,
  ) {}

  async flushOutbox(): Promise<void> {
    await this.outbox.processWith(this.inner, 100);
  }

  async pushTaskStatus(
    taskId: string,
    payload: { agentId: string; status: string; message?: string },
  ): Promise<void> {
    let primaryErr: unknown;
    try {
      await this.inner.pushTaskStatus(taskId, payload);
      return;
    } catch (e) {
      primaryErr = e;
    }
    if (this.fallback) {
      try {
        await this.fallback.pushTaskStatus(taskId, payload);
        return;
      } catch (e) {
        if (isCallbackNotFoundError(primaryErr) && isCallbackNotFoundError(e)) {
          console.warn(
            `[ResilientPlatformCallbackClient] callback 404 on all URLs; skip outbox (taskId=${taskId})`,
          );
          return;
        }
        await this.outbox.enqueue({ kind: "status", taskId, payload });
        return;
      }
    }
    if (isCallbackNotFoundError(primaryErr)) {
      console.warn(`[ResilientPlatformCallbackClient] callback 404; skip outbox (taskId=${taskId})`);
      return;
    }
    await this.outbox.enqueue({ kind: "status", taskId, payload });
  }

  async pushTaskLog(taskId: string, payload: TaskLogCallbackPayload): Promise<void> {
    let primaryErr: unknown;
    try {
      await this.inner.pushTaskLog(taskId, payload);
      return;
    } catch (e) {
      primaryErr = e;
    }
    if (this.fallback) {
      try {
        await this.fallback.pushTaskLog(taskId, payload);
        return;
      } catch (e) {
        if (isCallbackNotFoundError(primaryErr) && isCallbackNotFoundError(e)) {
          console.warn(
            `[ResilientPlatformCallbackClient] callback 404 on all URLs; skip outbox (taskId=${taskId})`,
          );
          return;
        }
        await this.outbox.enqueue({ kind: "log", taskId, payload });
        return;
      }
    }
    if (isCallbackNotFoundError(primaryErr)) {
      console.warn(`[ResilientPlatformCallbackClient] callback 404; skip outbox (taskId=${taskId})`);
      return;
    }
    await this.outbox.enqueue({ kind: "log", taskId, payload });
  }

  async pushTaskReport(taskId: string, payload: TaskReportCallbackPayload): Promise<void> {
    let primaryErr: unknown;
    try {
      await this.inner.pushTaskReport(taskId, payload);
      return;
    } catch (e) {
      primaryErr = e;
    }
    const b64 = payload.reportBundleBase64;
    if (b64 && b64.length > 4_000_000) {
      console.warn(
        "[ResilientPlatformCallbackClient] report too large to enqueue; drop outbox (taskId=" + taskId + ")",
      );
      return;
    }
    const dumpLen = payload.executionDumpJson?.length ?? 0;
    const assetsLen =
      payload.reportAssetFiles?.reduce((acc, f) => acc + (typeof f.base64 === "string" ? f.base64.length : 0), 0) ?? 0;
    if (dumpLen + assetsLen > 8_000_000) {
      console.warn(
        "[ResilientPlatformCallbackClient] execution dump payload too large to enqueue; drop outbox (taskId=" +
          taskId +
          ")",
      );
      return;
    }
    if (this.fallback) {
      try {
        await this.fallback.pushTaskReport(taskId, payload);
        return;
      } catch (e) {
        if (isCallbackNotFoundError(primaryErr) && isCallbackNotFoundError(e)) {
          console.warn(
            `[ResilientPlatformCallbackClient] callback 404 on all URLs; skip outbox (taskId=${taskId})`,
          );
          return;
        }
        await this.outbox.enqueue({ kind: "report", taskId, payload });
        return;
      }
    }
    if (isCallbackNotFoundError(primaryErr)) {
      console.warn(`[ResilientPlatformCallbackClient] callback 404; skip outbox (taskId=${taskId})`);
      return;
    }
    await this.outbox.enqueue({ kind: "report", taskId, payload });
  }
}
