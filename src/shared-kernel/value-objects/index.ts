import type { PlatformType } from "../enums/index.js";

export interface AgentCapability {
  supportedPlatforms: PlatformType[];
  maxConcurrentTasks: number;
}

export interface ResourceCapability {
  platform: PlatformType;
  supportsDebug: boolean;
  labels: string[];
}
