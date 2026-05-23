import type {
  ArtifactRepository,
  EventRepository,
  LeaseRepository,
  SessionRepository,
  TaskRepository,
} from "../../domain/repositories/index.js";
import { asLeaseId, asSessionId, asTaskId } from "../../shared-kernel/ids/index.js";

export class ObservationQueryService {
  constructor(
    private readonly taskRepository: TaskRepository,
    private readonly sessionRepository: SessionRepository,
    private readonly leaseRepository: LeaseRepository,
    private readonly artifactRepository: ArtifactRepository,
    private readonly eventRepository: EventRepository,
  ) {}

  async getTask(taskId: string) {
    return this.taskRepository.getById(asTaskId(taskId));
  }

  async getSession(sessionId: string) {
    const id = asSessionId(sessionId);
    const execution = await this.sessionRepository.getExecutionById(id);
    if (execution) return { sessionType: "execution" as const, session: execution };
    const debug = await this.sessionRepository.getDebugById(id);
    if (debug) return { sessionType: "debug" as const, session: debug };
    return null;
  }

  async getLease(leaseId: string) {
    return this.leaseRepository.getById(asLeaseId(leaseId));
  }

  async listArtifacts(taskId: string) {
    return this.artifactRepository.listByTaskId(asTaskId(taskId));
  }

  async listEvents(params: { taskId?: string; type?: string; limit?: number }) {
    const events = await this.eventRepository.list();
    const filtered = events.filter((event) => {
      const byType = params.type ? event.type === params.type : true;
      const payloadTaskId =
        event.payload && typeof event.payload === "object" && "taskId" in event.payload
          ? String((event.payload as { taskId?: unknown }).taskId ?? "")
          : "";
      const byTaskId = params.taskId ? payloadTaskId === params.taskId : true;
      return byType && byTaskId;
    });
    if (!params.limit || params.limit <= 0) return filtered;
    return filtered.slice(-params.limit);
  }
}
