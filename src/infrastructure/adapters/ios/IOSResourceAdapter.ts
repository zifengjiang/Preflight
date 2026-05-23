import type { ResourceAdapter } from "../../../adapter-spi/resource/index.js";
import { compactDeviceDetails } from "../../../domain/resource/DeviceDetails.js";
import { DeviceResource } from "../../../domain/resource/DeviceResource.js";
import { PlatformType, ResourceStatus } from "../../../shared-kernel/enums/index.js";
import { asResourceId } from "../../../shared-kernel/ids/index.js";
import type { CommandRunner } from "../../system/CommandRunner.js";
import {
  buildIosDeviceDetailsFromDisplayName,
  probeIosBatteryPercent,
  probeIosDeviceName,
  probeIosProductType,
} from "../deviceDetailsProbe.js";

export interface IOSTarget {
  name: string;
  udid: string;
}

/** simulator target from `xcrun simctl list devices booted` */
export interface SimulatorTarget {
  name: string;
  udid: string;
  runtime: string;
}

const DEVICE_LINE_PATTERN = /(.*)\(([-A-Za-z0-9]+)\)\s*$/;
const IOS_DEVICE_NAME_HINTS = ["iphone", "ipad", "ipod"];
const NON_IOS_HOST_HINTS = [
  "macbook",
  "mac mini",
  "imac",
  "mac studio",
  "mac pro",
  "my mac",
];

/** xctrace 真机常见展示：`别名 (16.7.8) (udid)`，与主机 `名称 (UUID)` 区分 */
const XCTRACE_IOS_VERSION_IN_DISPLAY_NAME = /\(\d{1,2}\.\d+(?:\.\d+)?\)/;

/** 匹配 simctl 设备行：`    iPhone 15 Pro (UUID) (Booted)` */
const SIMCTL_DEVICE_LINE = /^\s+(.+?)\s+\(([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\)\s+\((\w+)\)\s*$/;

/** 匹配 simctl Section Header：`-- iOS 17.4 --` 或 `-- iOS 17.4 (21F90) --` */
const SIMCTL_SECTION_HEADER = /^--\s+(.+?)\s+--$/;

function isLegacy40CharHexUdid(udid: string): boolean {
  return /^[0-9a-f]{40}$/i.test(udid.trim());
}

/** 如 `00008110-001C11111111111E`（8-4-12），与标准五段主机 UUID 区分 */
function isAppleMobileUdidThreeSegment(udid: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(udid.trim());
}

/** Instruments 列表里本机常为 RFC4122 五段式 */
function isStandardFivePartUuid(udid: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(udid.trim());
}

/**
 * 判断 `xcrun xctrace list devices` 的「== Devices ==」行是否为已连接的真机。
 * 不能仅靠名称里的 iphone/ipad：用户自定义设备名时仍会带系统版本号括号或 40 位 hex UDID。
 */
function isLikelyPhysicalIosDevice(name: string, udid: string): boolean {
  const normalized = name.trim().toLowerCase();
  const id = udid.trim();
  if (!normalized || !id) return false;
  if (normalized.includes("simulator")) return false;
  if (NON_IOS_HOST_HINTS.some((hint) => normalized.includes(hint))) return false;

  if (IOS_DEVICE_NAME_HINTS.some((hint) => normalized.includes(hint))) return true;
  if (isLegacy40CharHexUdid(id)) return true;
  if (isAppleMobileUdidThreeSegment(id)) return true;
  if (XCTRACE_IOS_VERSION_IN_DISPLAY_NAME.test(name)) return true;
  if (isStandardFivePartUuid(id)) return false;

  return false;
}

function extractOnlineDeviceLines(stdout: string): string[] {
  const lines = stdout.split("\n").map((line) => line.trim());
  const headingIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter((item) => item.line.startsWith("== ") && item.line.endsWith(" =="));
  const devicesHeading = headingIndexes.find((item) => item.line === "== Devices ==");

  // Fallback: unknown format, keep previous permissive behavior.
  if (!devicesHeading) {
    return lines.filter((line) => line.length > 0);
  }

  const nextHeading = headingIndexes.find((item) => item.index > devicesHeading.index);
  const end = nextHeading ? nextHeading.index : lines.length;
  return lines.slice(devicesHeading.index + 1, end).filter((line) => line.length > 0);
}

export function parseIOSDevices(stdout: string): IOSTarget[] {
  return extractOnlineDeviceLines(stdout)
    .map((line) => {
      const match = DEVICE_LINE_PATTERN.exec(line);
      if (!match) return null;
      const name = match[1]?.trim() ?? "";
      const udid = match[2]?.trim() ?? "";
      if (!isLikelyPhysicalIosDevice(name, udid)) return null;
      return { name, udid };
    })
    .filter((item): item is IOSTarget => item !== null && item.udid.length > 0);
}

function toIOSResourceId(udid: string): string {
  return `ios:${udid}`;
}

export function parseBootedSimulators(stdout: string): SimulatorTarget[] {
  const lines = stdout.split("\n");
  const result: SimulatorTarget[] = [];
  let currentRuntime: string | null = null;

  for (const line of lines) {
    const headerMatch = line.match(SIMCTL_SECTION_HEADER);
    if (headerMatch) {
      currentRuntime = headerMatch[1].trim();
      continue;
    }
    const deviceMatch = line.match(SIMCTL_DEVICE_LINE);
    if (deviceMatch && currentRuntime && deviceMatch[3] === "Booted") {
      result.push({
        name: deviceMatch[1].trim(),
        udid: deviceMatch[2],
        runtime: currentRuntime,
      });
    }
  }
  return result;
}

function osNameFromRuntime(runtime: string): string {
  const lower = runtime.toLowerCase();
  if (lower.startsWith("tvos")) return "tvOS";
  if (lower.startsWith("watchos")) return "watchOS";
  if (lower.startsWith("visionos")) return "visionOS";
  return "iOS";
}

function osVersionFromRuntime(runtime: string): string | undefined {
  const m = runtime.match(/(\d[\d.]*)/);
  return m ? m[1] : undefined;
}

export class IOSResourceAdapter implements ResourceAdapter {
  constructor(
    private readonly commandRunner: CommandRunner,
    private readonly discoveryCommand: string,
  ) {}

  adapterName(): string {
    return "IOSResourceAdapter";
  }

  async discover(): Promise<DeviceResource[]> {
    const [xctraceResult, simctlResult] = await Promise.all([
      this.commandRunner.run(this.discoveryCommand, 15_000),
      this.commandRunner.run("xcrun simctl list devices booted", 10_000),
    ]);

    const resources: DeviceResource[] = [];

    // 1) Real iOS devices via xctrace
    if (xctraceResult.ok) {
      const targets = parseIOSDevices(xctraceResult.stdout);
      const realDevices = await Promise.all(
        targets.map(async (target) => {
          const base = buildIosDeviceDetailsFromDisplayName(target.name);
          const [productType, batteryPercent, deviceName] = await Promise.all([
            probeIosProductType(this.commandRunner, target.udid),
            probeIosBatteryPercent(this.commandRunner, target.udid),
            probeIosDeviceName(this.commandRunner, target.udid),
          ]);
          const merged = compactDeviceDetails({
            ...base,
            ...(productType ? { model: productType } : {}),
            ...(batteryPercent != null ? { batteryPercent } : {}),
            ...(deviceName ? { deviceName } : {}),
          });
          return new DeviceResource(
            asResourceId(toIOSResourceId(target.udid)),
            PlatformType.IOS,
            ResourceStatus.ONLINE,
            {
              platform: PlatformType.IOS,
              supportsDebug: true,
              labels: ["real", "ios", target.name],
            },
            merged,
          );
        }),
      );
      resources.push(...realDevices);
    }

    // 2) Booted simulators via simctl
    if (simctlResult.ok) {
      const simTargets = parseBootedSimulators(simctlResult.stdout);
      for (const target of simTargets) {
        resources.push(
          new DeviceResource(
            asResourceId(toIOSResourceId(target.udid)),
            PlatformType.IOS,
            ResourceStatus.ONLINE,
            {
              platform: PlatformType.IOS,
              supportsDebug: true,
              labels: ["simulator", "ios", target.name],
            },
            compactDeviceDetails({
              manufacturer: "Apple",
              osName: osNameFromRuntime(target.runtime),
              osVersion: osVersionFromRuntime(target.runtime),
              model: target.name,
            }),
          ),
        );
      }
    }

    return resources;
  }
}
