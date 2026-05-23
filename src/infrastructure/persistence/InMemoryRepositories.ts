import type { AgentNode } from "../../domain/agent/AgentNode.js";
import type { ArtifactRef } from "../../domain/artifact/ArtifactRef.js";
import type { AgentEvent } from "../../domain/event/AgentEvent.js";
import type { Lease } from "../../domain/lease/Lease.js";
import type {
  AgentRepository,
  ArtifactRepository,
  EventRepository,
  LeaseRepository,
  ResourceRepository,
  SessionRepository,
  TaskRepository,
} from "../../domain/repositories/index.js";
import type { DeviceResource } from "../../domain/resource/DeviceResource.js";
import type { DebugSession } from "../../domain/session/DebugSession.js";
import type { ExecutionSession } from "../../domain/session/ExecutionSession.js";
import type { TaskRecord } from "../../domain/task/TaskRecord.js";
import { LeaseStatus } from "../../shared-kernel/enums/index.js";
import type { LeaseId, ResourceId, SessionId, TaskId } from "../../shared-kernel/ids/index.js";

export class InMemoryAgentRepository implements AgentRepository {
  private agent: AgentNode | null = null;
  async save(agent: AgentNode): Promise<void> {
    this.agent = agent;
  }
  async get(): Promise<AgentNode | null> {
    return this.agent;
  }
}

export class InMemoryResourceRepository implements ResourceRepository {
  private resources = new Map<string, DeviceResource>();
  async list(): Promise<DeviceResource[]> {
    return Array.from(this.resources.values());
  }
  async getById(id: ResourceId): Promise<DeviceResource | null> {
    return this.resources.get(id) ?? null;
  }
  async saveAll(resources: DeviceResource[]): Promise<void> {
    this.resources = new Map(resources.map((resource) => [resource.id, resource]));
  }
  async save(resource: DeviceResource): Promise<void> {
    this.resources.set(resource.id, resource);
  }
}

export class InMemoryLeaseRepository implements LeaseRepository {
  private leases = new Map<string, Lease>();
  async save(lease: Lease): Promise<void> {
    this.leases.set(lease.id, lease);
  }
  async getById(id: LeaseId): Promise<Lease | null> {
    return this.leases.get(id) ?? null;
  }
  async getActiveByResourceId(resourceId: ResourceId): Promise<Lease | null> {
    const lease = Array.from(this.leases.values()).find(
      (item) =>
        item.resourceId === resourceId &&
        item.status === LeaseStatus.ACTIVE &&
        new Date(item.expiresAt).getTime() > Date.now(),
    );
    return lease ?? null;
  }
}

export class InMemorySessionRepository implements SessionRepository {
  private executionSessions = new Map<string, ExecutionSession>();
  private debugSessions = new Map<string, DebugSession>();
  async saveExecution(session: ExecutionSession): Promise<void> {
    this.executionSessions.set(session.id, session);
  }
  async saveDebug(session: DebugSession): Promise<void> {
    this.debugSessions.set(session.id, session);
  }
  async getExecutionById(id: SessionId): Promise<ExecutionSession | null> {
    return this.executionSessions.get(id) ?? null;
  }
  async getDebugById(id: SessionId): Promise<DebugSession | null> {
    return this.debugSessions.get(id) ?? null;
  }

  async listDebugSessions(): Promise<DebugSession[]> {
    return Array.from(this.debugSessions.values());
  }
}

export class InMemoryTaskRepository implements TaskRepository {
  private tasks = new Map<string, TaskRecord>();
  async save(task: TaskRecord): Promise<void> {
    this.tasks.set(task.id, task);
  }
  async getById(id: TaskId): Promise<TaskRecord | null> {
    return this.tasks.get(id) ?? null;
  }

  async list(): Promise<TaskRecord[]> {
    return Array.from(this.tasks.values());
  }
}

export class InMemoryArtifactRepository implements ArtifactRepository {
  private artifacts = new Map<string, ArtifactRef[]>();
  async saveMany(artifacts: ArtifactRef[]): Promise<void> {
    if (artifacts.length === 0) return;
    const taskId = artifacts[0].taskId;
    const list = this.artifacts.get(taskId) ?? [];
    list.push(...artifacts);
    this.artifacts.set(taskId, list);
  }
  async listByTaskId(taskId: TaskId): Promise<ArtifactRef[]> {
    return this.artifacts.get(taskId) ?? [];
  }
}

export class InMemoryEventRepository implements EventRepository {
  private events: AgentEvent[] = [];
  async append(event: AgentEvent): Promise<void> {
    this.events.push(event);
  }
  async list(): Promise<AgentEvent[]> {
    return this.events;
  }
}
