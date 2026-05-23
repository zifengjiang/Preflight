import type { DeviceResource } from "./DeviceResource.js";

export class ResourceRegistry {
  constructor(public readonly resources: DeviceResource[]) {}
}
