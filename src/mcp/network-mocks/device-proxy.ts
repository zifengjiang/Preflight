import { execFileSync } from "node:child_process";

export interface DeviceProxyConfig {
  platform: "android" | "ios";
  /** e.g. "emulator-5554" (serial) or "xxx-xxx-xxx" (udid) */
  deviceId: string;
  /** Proxy host the device sees (e.g. "10.0.2.2" for Android emulator) */
  proxyHost: string;
  proxyPort: number;
}

/** A runner injectable for tests; defaults to execFileSync (argv array — NO shell). */
export type AdbRunner = (file: string, args: string[]) => void;

const defaultAdbRunner: AdbRunner = (file, args) => {
  execFileSync(file, args, { stdio: "pipe", timeout: 10_000 });
};

/** Build the adb argv to set the global http_proxy. deviceId is a discrete argv
 * element (not interpolated into a shell string), so it can never be shell-interpreted. */
export function buildSetProxyArgs(deviceId: string, proxy: string): string[] {
  return ["-s", deviceId, "shell", "settings", "put", "global", "http_proxy", proxy];
}

/** Build the adb argv to clear the global http_proxy. */
export function buildRemoveProxyArgs(deviceId: string): string[] {
  return ["-s", deviceId, "shell", "settings", "put", "global", "http_proxy", ":0"];
}

export function configureAndroidEmulatorProxy(config: DeviceProxyConfig, run: AdbRunner = defaultAdbRunner): void {
  const { deviceId, proxyHost, proxyPort } = config;
  const proxy = `${proxyHost}:${proxyPort}`;
  run("adb", buildSetProxyArgs(deviceId, proxy));
}

export function removeAndroidEmulatorProxy(serial: string, run: AdbRunner = defaultAdbRunner): void {
  run("adb", buildRemoveProxyArgs(serial));
}

export function configureDeviceProxy(config: DeviceProxyConfig, run: AdbRunner = defaultAdbRunner): void {
  if (config.platform === "android") {
    configureAndroidEmulatorProxy(config, run);
  }
  // iOS simulator proxy deferred to phase 2
}

export function removeDeviceProxy(platform: "android" | "ios", deviceId: string, run: AdbRunner = defaultAdbRunner): void {
  if (platform === "android") {
    removeAndroidEmulatorProxy(deviceId, run);
  }
  // iOS simulator proxy deferred to phase 2
}

/** Android emulator reaches the host at 10.0.2.2; iOS simulator uses loopback. */
export function proxyHostForPlatform(platform: "android" | "ios"): string {
  return platform === "android" ? "10.0.2.2" : "127.0.0.1";
}
