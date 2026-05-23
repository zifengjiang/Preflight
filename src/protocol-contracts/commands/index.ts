import type { PlatformType, OwnerType } from "../../shared-kernel/enums/index.js";

export interface AcquireLeaseCommand {
  type: "AcquireLeaseCommand";
  leaseId: string;
  resourceId: string;
  ownerId: string;
  ownerType: OwnerType;
  ttlSeconds: number;
  /** 可选：平台会话登录名（设备清单展示「谁占用」） */
  occupantUsername?: string;
  /** 可选：平台会话展示名 */
  occupantDisplayName?: string;
}

export interface RenewLeaseCommand {
  type: "RenewLeaseCommand";
  leaseId: string;
  ttlSeconds: number;
}

export interface ReleaseLeaseCommand {
  type: "ReleaseLeaseCommand";
  leaseId: string;
}

/** 平台运维：按资源标识撤销当前活跃租约（无需知晓 leaseId）；无活跃租约时幂等成功 */
export interface RevokeLeaseByResourceCommand {
  type: "RevokeLeaseByResourceCommand";
  resourceId: string;
}

export interface CreateTaskCommand {
  type: "CreateTaskCommand";
  taskId: string;
  requiredPlatform: PlatformType;
  script: string;
  /** 缺省为 midscene；airtest 表示执行原生 .air 包。 */
  scriptKind?: "midscene" | "airtest";
  /** 用例级运行标识，平台多用例串联时用于报告/日志归属。 */
  caseRunId?: string;
  caseIndex?: number;
  caseName?: string;
  /** Airtest zip 包 base64，仅 scriptKind=airtest 时使用。 */
  airtestBundleBase64?: string;
  /** zip 内 .air 入口目录名，例如 demo.air。 */
  airtestEntryDir?: string;
  airtestArchiveName?: string;
  runtimeEnv?: Record<string, string>;
  /** 指定资源执行；未传则走 selector / 平台自动选机 */
  resourceId?: string;
  selector?: {
    labels?: string[];
  };
}

export interface CancelTaskCommand {
  type: "CancelTaskCommand";
  taskId: string;
}

export interface CreateDebugSessionCommand {
  type: "CreateDebugSessionCommand";
  sessionId: string;
  resourceId: string;
  ownerId: string;
}

export interface SendDebugCommand {
  type: "SendDebugCommand";
  sessionId: string;
  command: string;
}

export interface CloseDebugSessionCommand {
  type: "CloseDebugSessionCommand";
  sessionId: string;
}

export interface StartLiveDebugSessionCommand {
  type: "StartLiveDebugSessionCommand";
  sessionId: string;
  resourceId: string;
  frameIntervalMs?: number;
}

export interface SendLiveDebugInputCommand {
  type: "SendLiveDebugInputCommand";
  sessionId: string;
  action: "tap" | "swipe" | "key";
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  durationMs?: number;
  coordinateSpace?: "image";
  sourceWidth?: number;
  sourceHeight?: number;
  key?: string;
}

export interface StopLiveDebugSessionCommand {
  type: "StopLiveDebugSessionCommand";
  sessionId: string;
}

/** 安装包：`appRef` 为本地绝对/相对路径、`file://` URL，或 `http(s)://` 下载地址（先下载再装）。 */
export interface InstallAppCommand {
  type: "InstallAppCommand";
  resourceId: string;
  appRef: string;
}

/** 按包名/bundleId 卸载（Android 包名、iOS bundle id、鸿蒙 bundle name）。 */
export interface UninstallAppCommand {
  type: "UninstallAppCommand";
  resourceId: string;
  bundleId: string;
}

export type { PlatformCommandEnvelope } from "./envelope.js";
export { parseInboundCommandJson } from "./envelope.js";

export type PlatformToAgentCommand =
  | AcquireLeaseCommand
  | RenewLeaseCommand
  | ReleaseLeaseCommand
  | RevokeLeaseByResourceCommand
  | CreateTaskCommand
  | CancelTaskCommand
  | CreateDebugSessionCommand
  | SendDebugCommand
  | CloseDebugSessionCommand
  | StartLiveDebugSessionCommand
  | SendLiveDebugInputCommand
  | StopLiveDebugSessionCommand
  | InstallAppCommand
  | UninstallAppCommand;
