import type {
  ArtifactType,
  EventType,
  LeaseStatus,
  PlatformType,
  ResourceStatus,
  SessionStatus,
  TaskStatus,
} from "../../shared-kernel/enums/index.js";

export interface AgentEventEnvelope<TPayload> {
  type: EventType;
  timestamp: string;
  payload: TPayload;
}

export interface AgentRegisteredPayload {
  agentId: string;
}

export interface HeartbeatPayload {
  agentId: string;
  healthy: boolean;
}

export interface ResourceChangedPayload {
  resourceId: string;
  status: ResourceStatus;
}

export interface LeaseChangedPayload {
  leaseId: string;
  resourceId: string;
  status: LeaseStatus;
}

export interface SessionChangedPayload {
  sessionId: string;
  status: SessionStatus;
}

export interface LiveDebugSessionChangedPayload {
  sessionId: string;
  resourceId: string;
  status: "STARTED" | "STOPPED" | "FAILED";
  message?: string;
}

export interface LiveDebugFramePayload {
  sessionId: string;
  resourceId: string;
  mimeType: string;
  dataBase64?: string;
  byteLength?: number;
  sourceUri?: string;
  capturedAt: string;
  /** iOS 为 WDA `/wda/activeAppInfo`；Android 为包名；鸿蒙为 bundle name（字段名仍用 `bundleId` 便于统一消费）。 */
  foregroundApp?: {
    bundleId?: string;
    name?: string;
    pid?: number;
  };
}

export interface LiveDebugInputAckPayload {
  sessionId: string;
  resourceId: string;
  ok: boolean;
  action: "tap" | "swipe" | "key";
  message?: string;
}

export interface TaskUpdatedPayload {
  taskId: string;
  status: TaskStatus;
  message?: string;
}

export interface ArtifactReadyPayload {
  taskId: string;
  artifactId: string;
  artifactType: ArtifactType;
  uri: string;
}

/** 与本机 `AGENT_APP_DOWNLOAD_DIR`（或默认临时根）下 `url-cache/` 目录索引一致 */
export interface AppPackageCacheChangedPayload {
  agentId: string;
  items: Array<{
    url: string;
    platform: PlatformType;
    /** Agent 本机绝对路径 */
    localPath: string;
    byteSize: number;
    downloadedAt: string;
  }>;
}
