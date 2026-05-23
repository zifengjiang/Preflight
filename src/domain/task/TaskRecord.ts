import type { TaskStatus } from "../../shared-kernel/enums/index.js";
import type { SessionId, TaskId } from "../../shared-kernel/ids/index.js";
import { TaskSpec } from "./TaskSpec.js";

export class TaskRecord {
  constructor(
    public readonly id: TaskId,
    public readonly spec: TaskSpec,
    public status: TaskStatus,
    public sessionId?: SessionId,
    public message?: string,
  ) {}
}
