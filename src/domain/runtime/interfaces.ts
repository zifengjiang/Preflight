import type { TaskSpec } from "../task/TaskSpec.js";
import type { ArtifactType } from "../../shared-kernel/enums/index.js";
import type { ResourceId } from "../../shared-kernel/ids/index.js";

export type MidsceneTaskReportInfo = {
  reportHtmlPath: string;
  reportName: string;
  reportFormat: "single-html" | "html-and-external-assets";
  reportBundleDir?: string;
  /** 临时文件：回调成功后应删除。 */
  reportBundleZipPath?: string;
};

export interface MidsceneExecutionResult {
  ok: boolean;
  message: string;
  artifacts: Array<{ type: ArtifactType; uri: string }>;
  reportInfo?: MidsceneTaskReportInfo;
}

export type MidsceneReportAssetFile = {
  relativePath: string;
  base64: string;
};

export type MidsceneReportProgressPayload = {
  reportHtml?: string;
  reportFormat: "single-html" | "html-and-external-assets";
  partial: boolean;
  /** 单文件为 `*.html`；目录模式为 bundle 目录名。 */
  reportName?: string;
  /** 目录模式整包 zip 的 file://（仅终态可能带） */
  reportBundleZipUri?: string;
  /** 合并后的 execution dump JSON（目录模式 + persistExecutionDump 时由 watcher 推送） */
  executionDumpJson?: string;
  executionDumpRevision?: number;
  reportAssetFiles?: MidsceneReportAssetFile[];
};

/** 实况前台应用：iOS 为 bundleId；Android 为包名；鸿蒙为 bundle name（统一放在 `bundleId` 便于消费）。 */
export type LiveDebugForegroundApp = {
  bundleId?: string;
  name?: string;
  pid?: number;
};

export interface MidsceneExecuteContext {
  runtimeEnv?: Record<string, string>;
  taskId?: string;
  onLogChunk?: (chunk: string, stream: "stdout" | "stderr") => void;
  onReportProgress?: (payload: MidsceneReportProgressPayload) => void;
}

export interface MidsceneRuntime {
  prepare?(task: TaskSpec, resourceId: ResourceId, signal?: AbortSignal): Promise<void>;
  execute(
    task: TaskSpec,
    resourceId: ResourceId,
    signal?: AbortSignal,
    context?: MidsceneExecuteContext,
  ): Promise<MidsceneExecutionResult>;
}

export interface DebugRuntime {
  runCommand(resourceId: ResourceId, command: string): Promise<{ output: string }>;
  snapshot(resourceId: ResourceId): Promise<{ uri: string }>;
  captureLiveFrame(resourceId: ResourceId): Promise<{
    mimeType: string;
    dataBase64: string;
    sourceUri: string;
    foregroundApp?: LiveDebugForegroundApp;
  }>;
  sendLiveInput(
    resourceId: ResourceId,
    input:
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
      | { action: "key"; key: string },
  ): Promise<{ output: string }>;
}
