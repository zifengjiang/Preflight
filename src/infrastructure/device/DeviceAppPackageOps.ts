import { PlatformType } from "../../shared-kernel/enums/index.js";
import type { CommandRunner } from "../system/CommandRunner.js";
import { buildAndroidAdbCliPrefix, buildHarmonyHdcShellPrefix, shSingleQuote } from "../adapters/deviceDetailsProbe.js";

/**
 * 卸载 CLI 非零退出且输出表明「包未安装 / 不存在」时视为幂等成功（与手动多卸一次一致）。
 * 用于单测与各端卸载容错；连接类错误仍应失败。
 */
export function isUninstallTargetAbsentOk(platform: PlatformType, stdout: string, stderr: string): boolean {
  const t = `${stdout}\n${stderr}`.toLowerCase();
  switch (platform) {
    case PlatformType.ANDROID:
      return (
        t.includes("failure [not installed") ||
        t.includes("unknown package") ||
        t.includes("package unknown") ||
        t.includes("delete_failed_unknown_package") ||
        t.includes("package not installed")
      );
    case PlatformType.IOS: {
      if (
        t.includes("could not connect to lockdownd") ||
        t.includes("could not start com.apple.mobile.installation_proxy") ||
        t.includes("could not connect to device")
      ) {
        return false;
      }
      return (
        t.includes("not installed on the device") ||
        t.includes("application not installed") ||
        t.includes("app not installed") ||
        (t.includes("uninstall") && t.includes("not installed")) ||
        (t.includes("uninstall") && t.includes("not found")) ||
        (t.includes("bundle identifier") && t.includes("not found")) ||
        t.includes("application not found") ||
        t.includes("no suitable application") ||
        t.includes("appnotfound")
      );
    }
    case PlatformType.HARMONY:
      return (
        t.includes("17700001") ||
        t.includes("bundle name does not exist") ||
        t.includes("specified bundle name is not found") ||
        t.includes("the specified bundle name is not found") ||
        t.includes("包不存在") ||
        t.includes("应用未安装") ||
        (t.includes("bundle") && t.includes("not found")) ||
        (t.includes("bundle") && t.includes("does not exist"))
      );
    default:
      return false;
  }
}

export type DeviceAppPackageOpsConfig = {
  /** 默认可执行文件名为 `ideviceinstaller` */
  ideviceinstallerExe?: string;
  adbHost?: string;
  adbPort?: number;
  harmonyHdcPath?: string;
  harmonyHdcHost?: string;
  harmonyHdcPort?: number;
};

export class DeviceAppPackageOps {
  constructor(
    private readonly runner: CommandRunner,
    private readonly config: DeviceAppPackageOpsConfig = {},
  ) {}

  private ideviceinstaller(): string {
    const exe = this.config.ideviceinstallerExe?.trim() || "ideviceinstaller";
    return /[^\w@%+=:,./-]/.test(exe) || exe.includes(" ") ? `"${exe.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : exe;
  }

  async installAndroid(serial: string, apkPath: string, timeoutMs: number): Promise<void> {
    const adb = buildAndroidAdbCliPrefix(this.config.adbHost, this.config.adbPort);
    const cmd = `${adb} -s ${shSingleQuote(serial)} install -r ${shSingleQuote(apkPath)}`;
    const res = await this.runner.run(cmd, timeoutMs);
    if (!res.ok) {
      throw new Error(`adb install failed (exit ${res.exitCode}): ${res.stderr || res.stdout}`);
    }
  }

  async uninstallAndroid(serial: string, packageName: string, timeoutMs: number): Promise<void> {
    const adb = buildAndroidAdbCliPrefix(this.config.adbHost, this.config.adbPort);
    const cmd = `${adb} -s ${shSingleQuote(serial)} uninstall ${shSingleQuote(packageName)}`;
    const res = await this.runner.run(cmd, timeoutMs);
    if (!res.ok && !isUninstallTargetAbsentOk(PlatformType.ANDROID, res.stdout, res.stderr)) {
      throw new Error(`adb uninstall failed (exit ${res.exitCode}): ${res.stderr || res.stdout}`);
    }
  }

  async installIos(udid: string, ipaPath: string, timeoutMs: number): Promise<void> {
    const exe = this.ideviceinstaller();
    const cmd = `${exe} -u ${shSingleQuote(udid)} install ${shSingleQuote(ipaPath)}`;
    const res = await this.runner.run(cmd, timeoutMs);
    if (!res.ok) {
      throw new Error(`ideviceinstaller install failed (exit ${res.exitCode}): ${res.stderr || res.stdout}`);
    }
  }

  async uninstallIos(udid: string, bundleId: string, timeoutMs: number): Promise<void> {
    const exe = this.ideviceinstaller();
    const cmd = `${exe} -u ${shSingleQuote(udid)} uninstall ${shSingleQuote(bundleId)}`;
    const res = await this.runner.run(cmd, timeoutMs);
    if (!res.ok && !isUninstallTargetAbsentOk(PlatformType.IOS, res.stdout, res.stderr)) {
      throw new Error(`ideviceinstaller uninstall failed (exit ${res.exitCode}): ${res.stderr || res.stdout}`);
    }
  }

  async installHarmony(deviceId: string, hapPath: string, timeoutMs: number): Promise<void> {
    const hdc = buildHarmonyHdcShellPrefix(this.config.harmonyHdcPath, this.config.harmonyHdcHost, this.config.harmonyHdcPort);
    const cmd = `${hdc} -t ${shSingleQuote(deviceId)} install -r ${shSingleQuote(hapPath)}`;
    const res = await this.runner.run(cmd, timeoutMs);
    if (!res.ok) {
      throw new Error(`hdc install failed (exit ${res.exitCode}): ${res.stderr || res.stdout}`);
    }
  }

  async uninstallHarmony(deviceId: string, bundleId: string, timeoutMs: number): Promise<void> {
    const hdc = buildHarmonyHdcShellPrefix(this.config.harmonyHdcPath, this.config.harmonyHdcHost, this.config.harmonyHdcPort);
    const cmd = `${hdc} -t ${shSingleQuote(deviceId)} uninstall ${shSingleQuote(bundleId)}`;
    const res = await this.runner.run(cmd, timeoutMs);
    if (!res.ok && !isUninstallTargetAbsentOk(PlatformType.HARMONY, res.stdout, res.stderr)) {
      throw new Error(`hdc uninstall failed (exit ${res.exitCode}): ${res.stderr || res.stdout}`);
    }
  }

  async install(platform: PlatformType, paths: { serial?: string; udid?: string; deviceId?: string }, packagePath: string, timeoutMs: number): Promise<void> {
    switch (platform) {
      case PlatformType.ANDROID:
        if (!paths.serial) throw new Error("missing android serial");
        await this.installAndroid(paths.serial, packagePath, timeoutMs);
        return;
      case PlatformType.IOS:
        if (!paths.udid) throw new Error("missing ios udid");
        await this.installIos(paths.udid, packagePath, timeoutMs);
        return;
      case PlatformType.HARMONY:
        if (!paths.deviceId) throw new Error("missing harmony device id");
        await this.installHarmony(paths.deviceId, packagePath, timeoutMs);
        return;
      default:
        throw new Error(`unsupported platform for install: ${platform}`);
    }
  }

  async uninstall(platform: PlatformType, paths: { serial?: string; udid?: string; deviceId?: string }, bundleId: string, timeoutMs: number): Promise<void> {
    switch (platform) {
      case PlatformType.ANDROID:
        if (!paths.serial) throw new Error("missing android serial");
        await this.uninstallAndroid(paths.serial, bundleId, timeoutMs);
        return;
      case PlatformType.IOS:
        if (!paths.udid) throw new Error("missing ios udid");
        await this.uninstallIos(paths.udid, bundleId, timeoutMs);
        return;
      case PlatformType.HARMONY:
        if (!paths.deviceId) throw new Error("missing harmony device id");
        await this.uninstallHarmony(paths.deviceId, bundleId, timeoutMs);
        return;
      default:
        throw new Error(`unsupported platform for uninstall: ${platform}`);
    }
  }
}
