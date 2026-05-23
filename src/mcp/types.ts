export type JsonObject = Record<string, unknown>;

export interface AgentHttpConfig {
  baseUrl: string;
  token?: string;
}

export interface AgentHealth {
  ok: boolean;
  raw?: unknown;
  error?: string;
}

export interface AgentResource {
  id: string;
  platform: string;
  status: string;
  capability?: unknown;
  deviceDetails?: unknown;
  occupancy?: unknown;
}

export interface AgentTask {
  id: string;
  status: string;
  message?: string;
  sessionId?: string;
  spec?: unknown;
}

export interface AgentEventSnapshot {
  type: string;
  timestamp: string;
  payload: JsonObject;
}

export interface AgentArtifact {
  id: string;
  taskId?: string;
  type: string;
  uri: string;
}

export interface RunState {
  runId: string;
  taskId: string;
  platform?: string;
  resourceId?: string;
  appRef?: string;
  testIntent?: string;
  script?: string;
  visualFlow?: unknown;
  createdAt: string;
  updatedAt: string;
  liveUrl: string;
  task?: AgentTask;
  events: AgentEventSnapshot[];
  artifacts: AgentArtifact[];
  flowStepView?: unknown;
  /** 终止来源记录：模型主动取消 / MCP 超时 / Agent 端失败等 */
  termination?: { source: string; detail: string; timestamp: string };
}

export interface FailureAnalysis {
  category: "none" | "device-or-environment" | "test-or-app-behavior" | "agent-or-runtime";
  summary: string;
  recommendation: string;
}

export interface RunSummary {
  runId: string;
  taskId: string;
  status: string;
  liveUrl: string;
  updatedAt: string;
  artifacts: AgentArtifact[];
  failureAnalysis: FailureAnalysis;
}

export interface EvidenceRun {
  runId: string;
  taskId: string;
  status: string;
  platform?: string;
  resourceId?: string;
  appRef?: string;
  testIntent?: string;
  script?: string;
  visualFlow?: unknown;
  createdAt: string;
  updatedAt: string;
  liveUrl: string;
  artifacts: AgentArtifact[];
  failureAnalysis: FailureAnalysis;
}
