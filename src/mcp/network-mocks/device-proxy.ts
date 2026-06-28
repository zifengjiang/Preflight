import { execSync } from "node:child_process";

export interface DeviceProxyConfig {
  platform: "android" | "ios";
  /** e.g. "emulator-5554" (serial) or "xxx-xxx-xxx" (udid) */
  deviceId: string;
  /** Proxy host the device sees (e.g. "10.0.2.2" for Android emulator) */
  proxyHost: string;
  proxyPort: number;
}

export function configureAndroidEmulatorProxy(config: DeviceProxyConfig): void {
  const { deviceId, proxyHost, proxyPort } = config;
  const proxy = `${proxyHost}:${proxyPort}`;
  execSync(`adb -s ${deviceId} shell settings put global http_proxy ${proxy}`, {
    stdio: "pipe",
    timeout: 10_000,
  });
}

export function removeAndroidEmulatorProxy(serial: string): void {
  execSync(`adb -s ${serial} shell settings put global http_proxy :0`, {
    stdio: "pipe",
    timeout: 10_000,
  });
}

export function configureDeviceProxy(config: DeviceProxyConfig): void {
  if (config.platform === "android") {
    configureAndroidEmulatorProxy(config);
  }
  // iOS simulator proxy deferred to phase 2
}

export function removeDeviceProxy(platform: "android" | "ios", deviceId: string): void {
  if (platform === "android") {
    removeAndroidEmulatorProxy(deviceId);
  }
  // iOS simulator proxy deferred to phase 2
}

/** Android emulator reaches the host at 10.0.2.2; iOS simulator uses loopback. */
export function proxyHostForPlatform(platform: "android" | "ios"): string {
  return platform === "android" ? "10.0.2.2" : "127.0.0.1";
}
