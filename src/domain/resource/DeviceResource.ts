import type { OwnerType, PlatformType, ResourceStatus } from "../../shared-kernel/enums/index.js";
import type { ResourceId } from "../../shared-kernel/ids/index.js";
import type { ResourceCapability } from "../../shared-kernel/value-objects/index.js";
import type { DeviceDetails } from "./DeviceDetails.js";

/** `/resources` 合并租约后的快照（供平台设备清单展示占用方） */
export type ResourceOccupancySnapshot = {
  leaseId: string;
  ownerId: string;
  ownerType: OwnerType;
  occupantUsername?: string;
  occupantDisplayName?: string;
};

export class DeviceResource {
  constructor(
    public readonly id: ResourceId,
    public readonly platform: PlatformType,
    public status: ResourceStatus,
    public readonly capability: ResourceCapability,
    public readonly deviceDetails?: DeviceDetails,
    public readonly occupancy?: ResourceOccupancySnapshot,
  ) {}
}
