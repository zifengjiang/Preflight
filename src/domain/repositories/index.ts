import type { AgentNode } from "../agent/AgentNode.js";
import type { ArtifactRef } from "../artifact/ArtifactRef.js";
import type { AgentEvent } from "../event/AgentEvent.js";
import type { Lease } from "../lease/Lease.js";
import type { DeviceResource } from "../resource/DeviceResource.js";
import type { DebugSession } from "../session/DebugSession.js";
import type { ExecutionSession } from "../session/ExecutionSession.js";
import type { TaskRecord } from "../task/TaskRecord.js";
import type { LeaseId, ResourceId, SessionId, TaskId } from "../../shared-kernel/ids/index.js";

export interface AgentRepository {
  save(agent: AgentNode): Promise<void>;
  get(): Promise<AgentNode | null>;
}

export interface ResourceRepository {
  list(): Promise<DeviceResource[]>;
  getById(id: ResourceId): Promise<DeviceResource | null>;
  saveAll(resources: DeviceResource[]): Promise<void>;
  save(resource: DeviceResource): Promise<void>;
}

export interface LeaseRepository {
  save(lease: Lease): Promise<void>;
  getById(id: LeaseId): Promise<Lease | null>;
  getActiveByResourceId(resourceId: ResourceId): Promise<Lease | null>;
}

export interface SessionRepository {
  saveExecution(session: ExecutionSession): Promise<void>;
  saveDebug(session: DebugSession): Promise<void>;
  getExecutionById(id: SessionId): Promise<ExecutionSession | null>;
  getDebugById(id: SessionId): Promise<DebugSession | null>;
  /** 仅内存实现需提供；用于 `/resources` 合并调试占用态 */
  listDebugSessions?(): Promise<DebugSession[]>;
}

export interface TaskRepository {
  save(task: TaskRecord): Promise<void>;
  getById(id: TaskId): Promise<TaskRecord | null>;
  /** 仅内存实现需提供；用于 `/resources` 合并任务占用态 */
  list?(): Promise<TaskRecord[]>;
}

export interface ArtifactRepository {
  saveMany(artifacts: ArtifactRef[]): Promise<void>;
  listByTaskId(taskId: TaskId): Promise<ArtifactRef[]>;
}

export interface EventRepository {
  append(event: AgentEvent): Promise<void>;
  list(): Promise<AgentEvent[]>;
}
