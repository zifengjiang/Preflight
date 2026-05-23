import type { DeviceResource } from "../../domain/resource/DeviceResource.js";

export interface ResourceAdapter {
  adapterName(): string;
  discover(): Promise<DeviceResource[]>;
}
