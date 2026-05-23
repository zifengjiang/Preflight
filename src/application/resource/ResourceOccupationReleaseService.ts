import type { SessionRepository, TaskRepository } from "../../domain/repositories/index.js";
import { SessionStatus, TaskStatus } from "../../shared-kernel/enums/index.js";
import type { DebugApplicationService } from "../debug/DebugApplicationService.js";
import type { LeaseApplicationService } from "../lease/LeaseApplicationService.js";
import type { TaskApplicationService } from "../task/TaskApplicationService.js";

/**
 * 与 `/resources` 合并逻辑对齐：占用可能来自调试会话、RUNNING 任务、或仅有租约。
 * 强制解除须三者一并回收，否则列表仍显示 DEBUGGING / RUNNING。
 */
export class ResourceOccupationReleaseService {
  constructor(
    private readonly taskService: TaskApplicationService,
    private readonly debugService: DebugApplicationService,
    private readonly leaseService: LeaseApplicationService,
    private readonly sessionRepo: SessionRepository,
    private readonly taskRepo: TaskRepository,
  ) {}

  async forceRelease(resourceIdRaw: string): Promise<void> {
    const resourceId = resourceIdRaw.trim();
    if (!resourceId) throw new Error("resourceId required");

    const matchesResource = (stored: unknown): boolean => String(stored) === resourceId;

    const listDebug = this.sessionRepo.listDebugSessions?.bind(this.sessionRepo);
    if (listDebug) {
      for (const s of await listDebug()) {
        if (s.status === SessionStatus.CLOSED) continue;
        if (!matchesResource(s.resourceId)) continue;
        await this.debugService.close(s.id);
      }
    }

    const listTasks = this.taskRepo.list?.bind(this.taskRepo);
    if (listTasks) {
      for (const t of await listTasks()) {
        if (t.status !== TaskStatus.RUNNING || !t.sessionId) continue;
        const exec = await this.sessionRepo.getExecutionById(t.sessionId);
        if (!exec) continue;
        if (!matchesResource(exec.resourceId)) continue;
        await this.taskService.cancel(t.id);
      }
    }

    await this.leaseService.revokeByResourceId(resourceId);
  }
}
