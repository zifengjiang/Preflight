export type AgentId = string & { readonly __brand: "AgentId" };
export type ResourceId = string & { readonly __brand: "ResourceId" };
export type LeaseId = string & { readonly __brand: "LeaseId" };
export type SessionId = string & { readonly __brand: "SessionId" };
export type TaskId = string & { readonly __brand: "TaskId" };
export type ArtifactId = string & { readonly __brand: "ArtifactId" };

export function asAgentId(value: string): AgentId {
  return value as AgentId;
}
export function asResourceId(value: string): ResourceId {
  return value as ResourceId;
}
export function asLeaseId(value: string): LeaseId {
  return value as LeaseId;
}
export function asSessionId(value: string): SessionId {
  return value as SessionId;
}
export function asTaskId(value: string): TaskId {
  return value as TaskId;
}
export function asArtifactId(value: string): ArtifactId {
  return value as ArtifactId;
}
