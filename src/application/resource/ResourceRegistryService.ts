import type { ResourceAdapter } from "../../adapter-spi/resource/index.js";
import type {
  LeaseRepository,
  ResourceRepository,
  SessionRepository,
  TaskRepository,
} from "../../domain/repositories/index.js";
import {
  DeviceResource,
  type ResourceOccupancySnapshot,
} from "../../domain/resource/DeviceResource.js";
import { EventType, ResourceStatus, SessionStatus, TaskStatus } from "../../shared-kernel/enums/index.js";
import type { ReporterApplicationService } from "../reporter/ReporterApplicationService.js";

export class ResourceRegistryService {
  private refreshInFlight: Promise<DeviceResource[]> | null = null;

  constructor(
    private readonly resourceRepository: ResourceRepository,
    private readonly adapters: ResourceAdapter[],
    private readonly reporter?: ReporterApplicationService,
    private readonly leaseRepository?: LeaseRepository | null,
    private readonly taskRepository?: TaskRepository | null,
    private readonly sessionRepository?: SessionRepository | null,
  ) {}

  async refresh(): Promise<DeviceResource[]> {
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      const previous = await this.resourceRepository.list();
      const previousMap = new Map(previous.map((item) => [item.id, item.status]));
      const discovered = await Promise.all(this.adapters.map((adapter) => adapter.discover()));
      const resources = discovered.flat();
      await this.resourceRepository.saveAll(resources);
      if (this.reporter) {
        for (const resource of resources) {
          const prevStatus = previousMap.get(resource.id);
          if (prevStatus == null || prevStatus !== resource.status) {
            await this.reporter.emit(EventType.RESOURCE_CHANGED, {
              resourceId: resource.id,
              status: resource.status,
            });
          }
        }
      }
      return resources;
    })();

    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  async list(): Promise<DeviceResource[]> {
    const raw = await this.resourceRepository.list();
    return this.mergeActivityIntoResourceStatus(raw);
  }

  /**
   * `/resources` 的物理发现结果始终为 ONLINE；租约与任务/调试状态单独存放。
   * 列出时合并：**调试会话未结束 → DEBUGGING**，**任务 RUNNING → RUNNING**，**仅有活跃租约 → LEASED**。
   */
  private async mergeActivityIntoResourceStatus(resources: DeviceResource[]): Promise<DeviceResource[]> {
    const leaseRepo = this.leaseRepository;
    const taskRepo = this.taskRepository;
    const sessionRepo = this.sessionRepository;
    if (!leaseRepo || !taskRepo || !sessionRepo) {
      return resources;
    }
    const listTasks = taskRepo.list?.bind(taskRepo);
    const listDebugSessions = sessionRepo.listDebugSessions?.bind(sessionRepo);
    if (!listTasks || !listDebugSessions) {
      return resources;
    }

    const byResource = new Map<string, ResourceStatus>();

    for (const s of await listDebugSessions()) {
      if (s.status === SessionStatus.CLOSED) continue;
      byResource.set(String(s.resourceId), ResourceStatus.DEBUGGING);
    }

    for (const t of await listTasks()) {
      if (t.status !== TaskStatus.RUNNING || !t.sessionId) continue;
      const exec = await sessionRepo.getExecutionById(t.sessionId);
      if (!exec) continue;
      const rid = String(exec.resourceId);
      if (byResource.get(rid) === ResourceStatus.DEBUGGING) continue;
      byResource.set(rid, ResourceStatus.RUNNING);
    }

    const now = new Date();
    const out: DeviceResource[] = [];
    for (const r of resources) {
      const rid = String(r.id);
      let next = byResource.get(rid);
      const lease = await leaseRepo.getActiveByResourceId(r.id);
      if (!next && lease?.isActive(now)) {
        next = ResourceStatus.LEASED;
      }
      let occupancy: ResourceOccupancySnapshot | undefined;
      if (lease?.isActive(now)) {
        occupancy = {
          leaseId: String(lease.id),
          ownerId: lease.ownerId,
          ownerType: lease.ownerType,
          ...(lease.occupantUsername?.trim()
            ? { occupantUsername: lease.occupantUsername.trim() }
            : {}),
          ...(lease.occupantDisplayName?.trim()
            ? { occupantDisplayName: lease.occupantDisplayName.trim() }
            : {}),
        };
      }
      const mergedStatus = next && next !== r.status ? next : r.status;
      out.push(new DeviceResource(r.id, r.platform, mergedStatus, r.capability, r.deviceDetails, occupancy));
    }
    return out;
  }
}
