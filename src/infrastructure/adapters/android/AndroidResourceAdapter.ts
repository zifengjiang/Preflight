import type { ResourceAdapter } from "../../../adapter-spi/resource/index.js";
import { DeviceResource } from "../../../domain/resource/DeviceResource.js";
import { PlatformType, ResourceStatus } from "../../../shared-kernel/enums/index.js";
import { asResourceId } from "../../../shared-kernel/ids/index.js";
import type { CommandRunner } from "../../system/CommandRunner.js";
import { probeAndroidDeviceDetails } from "../deviceDetailsProbe.js";

export interface AndroidTarget {
  serial: string;
  state: string;
}

export function parseAndroidDevices(stdout: string): AndroidTarget[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("List of devices attached"))
    .map((line) => {
      const [serial, state] = line.split(/\s+/);
      return { serial: serial ?? "", state: state ?? "" };
    })
    .filter((row) => row.serial.length > 0);
}

function toAndroidResourceId(serial: string): string {
  return `android:${serial}`;
}

export class AndroidResourceAdapter implements ResourceAdapter {
  constructor(
    private readonly commandRunner: CommandRunner,
    private readonly discoveryCommand: string,
    private readonly adbServerHost?: string,
    private readonly adbServerPort?: number,
  ) {}

  adapterName(): string {
    return "AndroidResourceAdapter";
  }

  async discover(): Promise<DeviceResource[]> {
    const result = await this.commandRunner.run(this.discoveryCommand, 15_000);
    if (!result.ok) return [];
    const targets = parseAndroidDevices(result.stdout).filter((item) => item.state === "device");
    const rows = await Promise.all(
      targets.map(async (target) => {
        const deviceDetails = await probeAndroidDeviceDetails(this.commandRunner, target.serial, 12_000, {
          host: this.adbServerHost,
          port: this.adbServerPort,
        });
        return new DeviceResource(
          asResourceId(toAndroidResourceId(target.serial)),
          PlatformType.ANDROID,
          ResourceStatus.ONLINE,
          {
            platform: PlatformType.ANDROID,
            supportsDebug: true,
            labels: ["real", "android", target.serial],
          },
          deviceDetails,
        );
      }),
    );
    return rows;
  }
}
