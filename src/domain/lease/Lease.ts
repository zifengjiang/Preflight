import { LeaseStatus, type OwnerType } from "../../shared-kernel/enums/index.js";
import type { LeaseId, ResourceId } from "../../shared-kernel/ids/index.js";

export class Lease {
  constructor(
    public readonly id: LeaseId,
    public readonly resourceId: ResourceId,
    public readonly ownerId: string,
    public readonly ownerType: OwnerType,
    public status: LeaseStatus,
    public expiresAt: string,
    /** 平台占用者登录名（与 AcquireLeaseCommand.occupantUsername 对齐）；可选兼容旧 Agent */
    public readonly occupantUsername?: string,
    /** 平台占用者展示名；可选 */
    public readonly occupantDisplayName?: string,
  ) {}

  isActive(now: Date): boolean {
    return this.status === LeaseStatus.ACTIVE && new Date(this.expiresAt).getTime() > now.getTime();
  }
}
