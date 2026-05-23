import type { SessionStatus, OwnerType } from "../../shared-kernel/enums/index.js";
import type { SessionId, LeaseId, ResourceId } from "../../shared-kernel/ids/index.js";

export abstract class BaseSession {
  constructor(
    public readonly id: SessionId,
    public readonly resourceId: ResourceId,
    public readonly leaseId: LeaseId,
    public readonly ownerId: string,
    public readonly ownerType: OwnerType,
    public status: SessionStatus,
  ) {}
}
