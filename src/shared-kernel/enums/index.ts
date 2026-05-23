export enum PlatformType {
  HARMONY = "HARMONY",
  ANDROID = "ANDROID",
  IOS = "IOS",
  WEB = "WEB",
}

export enum ResourceStatus {
  OFFLINE = "OFFLINE",
  ONLINE = "ONLINE",
  LEASED = "LEASED",
  RUNNING = "RUNNING",
  DEBUGGING = "DEBUGGING",
  ERROR = "ERROR",
}

export enum LeaseStatus {
  PENDING = "PENDING",
  ACTIVE = "ACTIVE",
  RELEASED = "RELEASED",
  EXPIRED = "EXPIRED",
  REJECTED = "REJECTED",
}

export enum SessionStatus {
  CREATED = "CREATED",
  RUNNING = "RUNNING",
  CLOSED = "CLOSED",
  FAILED = "FAILED",
}

export enum TaskStatus {
  CREATED = "CREATED",
  DISPATCHED = "DISPATCHED",
  RUNNING = "RUNNING",
  SUCCESS = "SUCCESS",
  FAILED = "FAILED",
  CANCELLED = "CANCELLED",
}

export enum ArtifactType {
  LOG = "LOG",
  TRACE = "TRACE",
  SCREENSHOT = "SCREENSHOT",
  VIDEO = "VIDEO",
  REPORT = "REPORT",
}

export enum EventType {
  AGENT_REGISTERED = "AgentRegisteredEvent",
  HEARTBEAT = "HeartbeatEvent",
  RESOURCE_CHANGED = "ResourceChangedEvent",
  LEASE_CHANGED = "LeaseChangedEvent",
  SESSION_CHANGED = "SessionChangedEvent",
  LIVE_DEBUG_SESSION_CHANGED = "LiveDebugSessionChangedEvent",
  LIVE_DEBUG_FRAME = "LiveDebugFrameEvent",
  LIVE_DEBUG_INPUT_ACK = "LiveDebugInputAckEvent",
  TASK_UPDATED = "TaskUpdatedEvent",
  ARTIFACT_READY = "ArtifactReadyEvent",
  HEALTH_WARNING = "HealthWarningEvent",
  /** 本机 http(s) 安装包 URL 缓存列表变化（新增下载、启动时索引加载、幽灵文件清理等） */
  APP_PACKAGE_CACHE_CHANGED = "AppPackageCacheChangedEvent",
}

export enum OwnerType {
  PLATFORM_TASK = "PLATFORM_TASK",
  DEBUG_CLIENT = "DEBUG_CLIENT",
  SYSTEM_MAINTENANCE = "SYSTEM_MAINTENANCE",
}
