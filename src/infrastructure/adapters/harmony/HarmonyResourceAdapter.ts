import type { ResourceAdapter } from "../../../adapter-spi/resource/index.js";
import { DeviceResource } from "../../../domain/resource/DeviceResource.js";
import { PlatformType, ResourceStatus } from "../../../shared-kernel/enums/index.js";
import { asResourceId } from "../../../shared-kernel/ids/index.js";
import type { CommandRunner } from "../../system/CommandRunner.js";
import { probeHarmonyDeviceDetails } from "../deviceDetailsProbe.js";

export function parseHarmonyTargets(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes("[Empty]"));
}

function toHarmonyResourceId(target: string): string {
  return `harmony:${target}`;
}

export class HarmonyResourceAdapter implements ResourceAdapter {
  constructor(
    private readonly commandRunner: CommandRunner,
    private readonly discoveryCommand: string,
    private readonly hdcShellPrefix: string = "hdc",
  ) {}

  adapterName(): string {
    return "HarmonyResourceAdapter";
  }

  async discover(): Promise<DeviceResource[]> {
    const result = await this.commandRunner.run(this.discoveryCommand, 15_000);
    if (!result.ok) return [];
    const targets = parseHarmonyTargets(result.stdout);
    return Promise.all(
      targets.map(async (target) => {
        const deviceDetails = await probeHarmonyDeviceDetails(this.commandRunner, this.hdcShellPrefix, target);
        return new DeviceResource(asResourceId(toHarmonyResourceId(target)), PlatformType.HARMONY, ResourceStatus.ONLINE, {
          platform: PlatformType.HARMONY,
          supportsDebug: true,
          labels: ["real", "harmony", target],
        }, deviceDetails);
      }),
    );
  }
}
