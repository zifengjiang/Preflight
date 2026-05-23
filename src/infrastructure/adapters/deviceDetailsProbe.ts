import type { DeviceDetails } from "../../domain/resource/DeviceDetails.js";
import { compactDeviceDetails } from "../../domain/resource/DeviceDetails.js";
import type { CommandRunner } from "../system/CommandRunner.js";

export function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

/** 供 hdc 探测子命令与会话参数一致（可执行路径含空格时加引号） */
export function buildHarmonyHdcShellPrefix(
  hdcPath: string | undefined,
  hdcHost: string | undefined,
  hdcPort: number | undefined,
): string {
  const trimmedPath = hdcPath?.trim();
  const rawExe = trimmedPath || "hdc";
  const exe =
    /[^\w@%+=:,./-]/.test(rawExe) || rawExe.includes(" ")
      ? `"${rawExe.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
      : rawExe;
  const host = hdcHost?.trim();
  if (host && hdcPort != null && Number.isFinite(hdcPort) && hdcPort > 0) {
    return `${exe} -s ${host}:${Math.floor(hdcPort)}`;
  }
  return exe;
}

/**
 * 解析 `adb shell` 多行 getprop 输出。
 * - 7 行：manufacturer, brand, model, device, release, sdk, fingerprint（与 ANDROID_PROP_SHELL 一致）
 * - 4 行：兼容旧版 manufacturer, model, release, sdk
 */
export function parseAndroidGetpropBlock(stdout: string): Pick<
  DeviceDetails,
  "manufacturer" | "brand" | "model" | "deviceCodename" | "osVersion" | "buildFingerprint"
> {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  let manufacturer: string | undefined;
  let brand: string | undefined;
  let model: string | undefined;
  let deviceCodename: string | undefined;
  let release: string | undefined;
  let sdk: string | undefined;
  let fingerprint: string | undefined;

  if (lines.length >= 7) {
    manufacturer = lines[0];
    brand = lines[1];
    model = lines[2];
    deviceCodename = lines[3];
    release = lines[4];
    sdk = lines[5];
    fingerprint = lines[6];
  } else if (lines.length >= 4) {
    manufacturer = lines[0];
    model = lines[1];
    release = lines[2];
    sdk = lines[3];
  } else {
    return {};
  }
  const parts: string[] = [];
  if (release) parts.push(release);
  if (sdk && /^\d+$/.test(sdk)) parts.push(`API ${sdk}`);
  const osVersion = parts.length ? parts.join(" · ") : undefined;
  return {
    manufacturer: manufacturer || undefined,
    brand: brand || undefined,
    model: model || undefined,
    deviceCodename: deviceCodename || undefined,
    osVersion,
    buildFingerprint: fingerprint || undefined,
  };
}

/** 与 MIDSCENE_ANDROID_ADB_HOST / MIDSCENE_ANDROID_ADB_PORT 对齐；非本机默认 daemon 时加 `-H` `-P`。 */
export function buildAndroidAdbCliPrefix(adbHost?: string, adbPort?: number): string {
  const host = (adbHost ?? "").trim() || "127.0.0.1";
  const p = adbPort != null && Number.isFinite(adbPort) && adbPort > 0 ? Math.floor(adbPort) : 5037;
  if ((host === "127.0.0.1" || host === "localhost") && p === 5037) {
    return "adb";
  }
  const safeHost = /[\s'"\\]/.test(host) ? shSingleQuote(host) : host;
  return `adb -H ${safeHost} -P ${p}`;
}

export function parseBatteryLevelFromDumpsys(stdout: string): number | null {
  const m = stdout.match(/^\s*level:\s*(\d+)\s*$/im);
  if (m?.[1]) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
  }
  return null;
}

export function parseHarmonyBatteryCapacity(stdout: string): number | null {
  const m = stdout.match(/^\s*capacity:\s*(\d+)\s*$/im);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
  return null;
}

const ANDROID_PROP_SHELL =
  "getprop ro.product.manufacturer; getprop ro.product.brand; getprop ro.product.model; getprop ro.product.device; getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.build.fingerprint";

/** Android / Harmony：系统设置中的本机名称（优先 global device_name，否则 secure bluetooth_name）。 */
const SHELL_USER_DEVICE_NAME =
  'n=$(settings get global device_name); case "$n" in ""|null|NULL) settings get secure bluetooth_name;; *) printf %s "$n";; esac';

const HARMONY_PARAM_SHELL =
  "param get const.product.manufacturer; param get const.product.brand; param get const.product.name; param get const.product.model; param get const.build.product; param get const.product.os.dist.name; param get const.product.os.dist.version; param get const.product.os.dist.apiversion; param get const.product.software.version";

/** 解析 `settings get` 类单行输出，忽略 null/空。 */
export function normalizeShellSettingsDeviceName(stdout: string): string | undefined {
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line || /^null$/i.test(line) || line === "N/A") return undefined;
  return line;
}

export function parseHarmonyParamBlock(stdout: string): Pick<
  DeviceDetails,
  "manufacturer" | "brand" | "deviceName" | "model" | "deviceCodename" | "osName" | "osVersion" | "buildFingerprint"
> {
  const lines = stdout.split("\n").map((l) => l.trim().replace(/^"(.*)"$/, "$1"));
  const [manufacturer, brand, productName, model, deviceCodename, osName, osDistVersion, osDistApiVersion, softwareVersion] = lines;
  const osParts: string[] = [];
  if (osDistVersion) osParts.push(osDistVersion);
  if (osDistApiVersion && /^\d+$/.test(osDistApiVersion)) osParts.push(`API ${osDistApiVersion}`);

  return {
    manufacturer: manufacturer || undefined,
    brand: brand || undefined,
    deviceName: productName || undefined,
    model: model || undefined,
    deviceCodename: deviceCodename || undefined,
    osName: osName || undefined,
    osVersion: osParts.length ? osParts.join(" · ") : undefined,
    buildFingerprint: softwareVersion || undefined,
  };
}

export async function probeAndroidDeviceDetails(
  runner: CommandRunner,
  serial: string,
  timeoutMs = 12_000,
  adbServer?: { host?: string; port?: number },
): Promise<DeviceDetails | undefined> {
  const adbCli = buildAndroidAdbCliPrefix(adbServer?.host, adbServer?.port);
  const sq = shSingleQuote(serial);
  const propsCmd = `${adbCli} -s ${sq} shell ${JSON.stringify(ANDROID_PROP_SHELL)}`;
  const batCmd = `${adbCli} -s ${sq} shell dumpsys battery 2>/dev/null | head -n 40`;
  const nameCmd = `${adbCli} -s ${sq} shell ${JSON.stringify(SHELL_USER_DEVICE_NAME)}`;
  const [propsRes, batRes, nameRes] = await Promise.all([
    runner.run(propsCmd, timeoutMs),
    runner.run(batCmd, timeoutMs),
    runner.run(nameCmd, timeoutMs),
  ]);
  if (!propsRes.ok && !batRes.ok) return undefined;
  const base: DeviceDetails = { osName: "Android" };
  if (propsRes.ok) Object.assign(base, parseAndroidGetpropBlock(propsRes.stdout));
  if (batRes.ok) {
    const level = parseBatteryLevelFromDumpsys(batRes.stdout);
    if (level != null) base.batteryPercent = level;
  }
  if (nameRes.ok) {
    const deviceName = normalizeShellSettingsDeviceName(nameRes.stdout);
    if (deviceName) base.deviceName = deviceName;
  }
  return compactDeviceDetails(base);
}

const IOS_VERSION_IN_NAME = /\((\d{1,2}\.\d+(?:\.\d+)?)\)\s*$/;

/**
 * 仅从 xctrace 展示名解析 iOS 版本（型号须用 ideviceinfo -k ProductType，勿把用户设备名当型号）。
 */
export function buildIosDeviceDetailsFromDisplayName(displayName: string): DeviceDetails {
  const name = displayName.trim();
  const m = IOS_VERSION_IN_NAME.exec(name);
  const osVersion = m?.[1];
  return compactDeviceDetails({
    manufacturer: "Apple",
    osName: "iOS",
    osVersion: osVersion || undefined,
  }) ?? { manufacturer: "Apple", osName: "iOS" };
}

/** 硬件型号标识，如 iPhone15,2 */
export async function probeIosProductType(
  runner: CommandRunner,
  udid: string,
  timeoutMs = 8_000,
): Promise<string | undefined> {
  const sq = shSingleQuote(udid);
  const cmd = `ideviceinfo -u ${sq} -k ProductType 2>/dev/null`;
  const res = await runner.run(cmd, timeoutMs);
  if (!res.ok) return undefined;
  const line = (res.stdout.trim().split(/\s+/)[0] ?? "").trim();
  if (!line || line === "N/A") return undefined;
  return line;
}

export async function probeIosBatteryPercent(
  runner: CommandRunner,
  udid: string,
  timeoutMs = 8_000,
): Promise<number | null> {
  const sq = shSingleQuote(udid);
  const cmd = `ideviceinfo -u ${sq} -q com.apple.mobile.battery -k BatteryCurrentCapacity 2>/dev/null`;
  const res = await runner.run(cmd, timeoutMs);
  if (!res.ok) return null;
  const raw = res.stdout.trim();
  if (!raw) return null;
  const token = raw.split(/\s+/)[0] ?? "";
  const n = Number(token);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** iOS 设置中的设备名称（与 xctrace 列表展示名不同）。 */
export async function probeIosDeviceName(
  runner: CommandRunner,
  udid: string,
  timeoutMs = 8_000,
): Promise<string | undefined> {
  const sq = shSingleQuote(udid);
  const cmd = `ideviceinfo -u ${sq} -k DeviceName 2>/dev/null`;
  const res = await runner.run(cmd, timeoutMs);
  if (!res.ok) return undefined;
  const line = (res.stdout.trim().split(/\n/)[0] ?? "").trim();
  if (!line || line === "N/A") return undefined;
  return line;
}

export async function probeHarmonyDeviceDetails(
  runner: CommandRunner,
  hdcShellPrefix: string,
  target: string,
  timeoutMs = 12_000,
): Promise<DeviceDetails | undefined> {
  const prefix = hdcShellPrefix.trim() || "hdc";
  const tq = shSingleQuote(target);
  const propsCmd = `${prefix} -t ${tq} shell ${JSON.stringify(HARMONY_PARAM_SHELL)}`;
  const batCmd = `${prefix} -t ${tq} shell hidumper -s BatteryService -a -i`;
  const [propsRes, batRes] = await Promise.all([
    runner.run(propsCmd, timeoutMs),
    runner.run(batCmd, timeoutMs),
  ]);
  if (!propsRes.ok) return undefined;
  const base: DeviceDetails = { osName: "HarmonyOS" };
  Object.assign(base, parseHarmonyParamBlock(propsRes.stdout));
  if (batRes.ok) {
    const level = parseHarmonyBatteryCapacity(batRes.stdout);
    if (level != null) base.batteryPercent = level;
  }
  return compactDeviceDetails(base);
}
