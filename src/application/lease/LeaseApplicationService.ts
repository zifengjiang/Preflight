import { Lease } from "../../domain/lease/Lease.js";
import type { LeaseRepository } from "../../domain/repositories/index.js";
import { LeaseConflictError, LeaseRequiredError } from "../../shared-kernel/errors/index.js";
import { EventType, LeaseStatus, type OwnerType } from "../../shared-kernel/enums/index.js";
import {
  asLeaseId,
  asResourceId,
  type LeaseId,
  type ResourceId,
} from "../../shared-kernel/ids/index.js";
import type { ReporterApplicationService } from "../reporter/ReporterApplicationService.js";

export class LeaseApplicationService {
  constructor(
    private readonly leaseRepository: LeaseRepository,
    private readonly reporter?: ReporterApplicationService,
  ) {}

  private async emitLeaseChanged(lease: Lease): Promise<void> {
    if (!this.reporter) return;
    await this.reporter.emit(EventType.LEASE_CHANGED, {
      leaseId: lease.id,
      resourceId: lease.resourceId,
      status: lease.status,
    });
  }

  async acquire(
    leaseId: string,
    resourceId: string,
    ownerId: string,
    ownerType: OwnerType,
    ttlSeconds: number,
    occupant?: { username?: string; displayName?: string },
  ): Promise<Lease> {
    const rid = asResourceId(resourceId);
    const activeLease = await this.leaseRepository.getActiveByResourceId(rid);
    const now = new Date();
    if (activeLease && activeLease.isActive(now)) {
      throw new LeaseConflictError(resourceId);
    }
    if (activeLease) {
      activeLease.status = LeaseStatus.REJECTED;
      await this.leaseRepository.save(activeLease);
      await this.emitLeaseChanged(activeLease);
    }
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const ou = occupant?.username?.trim();
    const od = occupant?.displayName?.trim();
    const lease = new Lease(
      asLeaseId(leaseId),
      rid,
      ownerId,
      ownerType,
      LeaseStatus.ACTIVE,
      expiresAt,
      ou || undefined,
      od || undefined,
    );
    await this.leaseRepository.save(lease);
    await this.emitLeaseChanged(lease);
    return lease;
  }

  async release(leaseId: LeaseId): Promise<Lease | null> {
    const lease = await this.leaseRepository.getById(leaseId);
    if (!lease) return null;
    lease.status = LeaseStatus.RELEASED;
    await this.leaseRepository.save(lease);
    await this.emitLeaseChanged(lease);
    return lease;
  }

  async renew(leaseId: LeaseId, ttlSeconds: number): Promise<Lease | null> {
    const lease = await this.leaseRepository.getById(leaseId);
    if (!lease) return null;
    lease.expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    await this.leaseRepository.save(lease);
    await this.emitLeaseChanged(lease);
    return lease;
  }

  /**
   * 按资源撤销当前活跃租约（与 ReleaseLeaseCommand 等效，但只需 resourceId）。
   * 无活跃租约时返回 null（调用方仍可视为成功）。
   */
  async revokeByResourceId(resourceId: string): Promise<Lease | null> {
    const rid = asResourceId(resourceId);
    const lease = await this.leaseRepository.getActiveByResourceId(rid);
    if (!lease) return null;
    lease.status = LeaseStatus.RELEASED;
    await this.leaseRepository.save(lease);
    await this.emitLeaseChanged(lease);
    return lease;
  }

  async ensureActive(resourceId: ResourceId): Promise<Lease> {
    const lease = await this.leaseRepository.getActiveByResourceId(resourceId);
    if (!lease || !lease.isActive(new Date())) throw new LeaseRequiredError(resourceId);
    return lease;
  }
}
