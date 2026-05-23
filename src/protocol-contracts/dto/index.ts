export interface AgentInfoResponse {
  agentId: string;
  online: boolean;
}

export interface DeviceDetailsDto {
  manufacturer?: string;
  brand?: string;
  /** 用户在系统设置中的本机名称 */
  deviceName?: string;
  model?: string;
  deviceCodename?: string;
  osName?: string;
  osVersion?: string;
  buildFingerprint?: string;
  batteryPercent?: number | null;
}

export interface ResourceListResponse {
  resources: Array<{
    resourceId: string;
    platform: string;
    status: string;
    deviceDetails?: DeviceDetailsDto;
  }>;
}

export interface LeaseInfoResponse {
  leaseId: string;
  resourceId: string;
  status: string;
}

export interface TaskInfoResponse {
  taskId: string;
  status: string;
}

export interface SessionInfoResponse {
  sessionId: string;
  status: string;
}

export interface ArtifactListResponse {
  artifacts: Array<{ artifactId: string; type: string; uri: string }>;
}
