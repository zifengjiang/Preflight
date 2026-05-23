import { PlatformType } from "../shared-kernel/enums/index.js";

export type ParsedDeviceTarget =
  | { platform: PlatformType.ANDROID; serial: string }
  | { platform: PlatformType.IOS; udid: string }
  | { platform: PlatformType.HARMONY; deviceId: string };

/** 与 ResourceAdapter 生成的 `android:` / `ios:` / `harmony:` 前缀一致 */
export function parseDeviceTargetFromResourceId(resourceId: string): ParsedDeviceTarget | null {
  const id = resourceId.trim();
  if (id.startsWith("android:")) {
    const serial = id.slice("android:".length).trim();
    if (!serial) return null;
    return { platform: PlatformType.ANDROID, serial };
  }
  if (id.startsWith("ios:")) {
    const udid = id.slice("ios:".length).trim();
    if (!udid) return null;
    return { platform: PlatformType.IOS, udid };
  }
  if (id.startsWith("harmony:")) {
    const deviceId = id.slice("harmony:".length).trim();
    if (!deviceId) return null;
    return { platform: PlatformType.HARMONY, deviceId };
  }
  return null;
}
