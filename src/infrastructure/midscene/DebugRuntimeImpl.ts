import type { DebugRuntime, LiveDebugForegroundApp } from "../../domain/runtime/interfaces.js";
import type { ResourceId } from "../../shared-kernel/ids/index.js";
import type { CommandExecutor } from "../../adapter-spi/command/index.js";
import type { SnapshotProvider } from "../../adapter-spi/snapshot/index.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { CommandRunner } from "../system/CommandRunner.js";
import { AndroidDevice } from "@midscene/android";
import type { HarmonyDevice } from "@midscene/harmony";
import { IOSDevice } from "@midscene/ios";
import { connectHarmonyAgentDebugDevice, extractHarmonyDeviceIdFromResourceId } from "../../utils/harmonyAgentDebugDevice.js";
import { extractIosUdidFromResourceId, resolveIosWdaPortForLiveDebug } from "../../utils/iosAgentDebugDevice.js";
import { captureFirstJpegFromWdaMjpegStream } from "../../utils/iosMjpegCapture.js";
import {
  parseAndroidForegroundFromDumpsys,
  parseHarmonyForegroundFromShellDump,
} from "../../utils/liveDebugForegroundParse.js";

type LiveImageCoordinateMeta = {
  coordinateSpace?: "image";
  sourceWidth?: number;
  sourceHeight?: number;
};

type LiveInputAction =
  | ({ action: "tap"; x: number; y: number } & LiveImageCoordinateMeta)
  | ({ action: "swipe"; x: number; y: number; x2: number; y2: number; durationMs?: number } & LiveImageCoordinateMeta)
  | { action: "key"; key: string };

interface DebugRuntimeOptions {
  androidAdbHost?: string;
  androidAdbPort?: number;
  androidScrcpyMaxSize?: number;
  androidScrcpyVideoBitRate?: number;
  androidScrcpyIdleTimeoutMs?: number;
  harmonyHdcPath?: string;
  harmonyHdcHost?: string;
  harmonyHdcPort?: number;
  iosWdaHost?: string;
  iosWdaPortMapFilePath?: string;
  iosWdaPortRangeStart?: number;
  iosWdaPortRangeEnd?: number;
  iosWdaExplicitPort?: number;
  /** 本机 MJPEG 端口；未设置时默认 = 解析到的 WDA 命令端口 + 1000（与 scripts/start-ios-wda.sh 一致） */
  iosWdaMjpegPort?: number;
}

export class DebugRuntimeImpl implements DebugRuntime {
  private readonly androidDevices = new Map<string, AndroidDevice>();
  private readonly androidDeviceConnecting = new Map<string, Promise<AndroidDevice>>();
  private readonly harmonyDevices = new Map<string, HarmonyDevice>();
  private readonly harmonyDeviceConnecting = new Map<string, Promise<HarmonyDevice>>();
  private readonly iosDevices = new Map<string, IOSDevice>();
  private readonly iosDeviceConnecting = new Map<string, Promise<IOSDevice>>();

  constructor(
    private readonly commandExecutor: CommandExecutor,
    private readonly snapshotProvider: SnapshotProvider,
    private readonly commandRunner: CommandRunner,
    private readonly options: DebugRuntimeOptions = {},
  ) {}

  async runCommand(resourceId: ResourceId, command: string): Promise<{ output: string }> {
    return this.commandExecutor.execute(resourceId, command);
  }

  async snapshot(resourceId: ResourceId): Promise<{ uri: string }> {
    return this.snapshotProvider.snapshot(resourceId);
  }

  async captureLiveFrame(resourceId: ResourceId): Promise<{
    mimeType: string;
    dataBase64: string;
    sourceUri: string;
    foregroundApp?: LiveDebugForegroundApp;
  }> {
    if (this.isAndroidResource(resourceId)) {
      return this.captureAndroidFrame(resourceId);
    }
    if (this.isHarmonyResource(resourceId)) {
      return this.captureHarmonyFrame(resourceId);
    }
    if (this.isIosResource(resourceId)) {
      return this.captureIosFrame(resourceId);
    }
    const shot = await this.snapshotProvider.snapshot(resourceId);
    const sourceUri = shot.uri.trim();
    if (!sourceUri) {
      throw new Error("snapshot uri is empty");
    }

    if (sourceUri.startsWith("data:")) {
      const match = sourceUri.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) {
        throw new Error("unsupported data uri format");
      }
      return {
        mimeType: match[1],
        dataBase64: match[2],
        sourceUri,
      };
    }

    if (!sourceUri.startsWith("file://")) {
      throw new Error(`unsupported snapshot uri for live frame: ${sourceUri}`);
    }
    const filePath = fileURLToPath(sourceUri);
    const data = await readFile(filePath);
    return {
      mimeType: "image/png",
      dataBase64: data.toString("base64"),
      sourceUri,
    };
  }

  async sendLiveInput(
    resourceId: ResourceId,
    input: LiveInputAction,
  ): Promise<{ output: string }> {
    if (this.isAndroidResource(resourceId)) {
      return this.sendAndroidInput(resourceId, input);
    }
    if (this.isHarmonyResource(resourceId)) {
      return this.sendHarmonyInput(resourceId, input);
    }
    if (this.isIosResource(resourceId)) {
      return this.sendIosInput(resourceId, input);
    }
    const command = this.renderLiveInputCommand(input);
    return this.commandExecutor.execute(resourceId, command);
  }

  private isAndroidResource(resourceId: ResourceId): boolean {
    return String(resourceId).toLowerCase().startsWith("android:");
  }

  private isHarmonyResource(resourceId: ResourceId): boolean {
    return String(resourceId).toLowerCase().startsWith("harmony:");
  }

  private isIosResource(resourceId: ResourceId): boolean {
    return String(resourceId).toLowerCase().startsWith("ios:");
  }

  private getIosWdaHost(): string {
    const fromOptions = this.options.iosWdaHost?.trim();
    if (fromOptions) return fromOptions;
    return process.env.MIDSCENE_IOS_WDA_HOST?.trim() || process.env.IOS_WDA_HOST?.trim() || "127.0.0.1";
  }

  private buildIosWdaResolveParams(resourceId: string) {
    const wdaHost = this.getIosWdaHost();
    return {
      resourceId,
      wdaHost,
      portMapFilePath: this.options.iosWdaPortMapFilePath,
      portRangeStart:
        Number.isFinite(this.options.iosWdaPortRangeStart) && (this.options.iosWdaPortRangeStart ?? 0) > 0
          ? Math.floor(this.options.iosWdaPortRangeStart!)
          : 8200,
      portRangeEnd:
        Number.isFinite(this.options.iosWdaPortRangeEnd) && (this.options.iosWdaPortRangeEnd ?? 0) > 0
          ? Math.floor(this.options.iosWdaPortRangeEnd!)
          : 8399,
      explicitWdaPort: this.options.iosWdaExplicitPort,
    };
  }

  private async resolveIosWdaCommandPortForResource(resourceId: ResourceId): Promise<number> {
    return resolveIosWdaPortForLiveDebug(this.commandRunner, this.buildIosWdaResolveParams(String(resourceId)));
  }

  /** 显式环境覆盖；否则与 start-ios-wda：本机 MJPEG = WDA 命令端口 + 1000 */
  private getIosWdaMjpegPort(wdaCommandPort: number): number {
    const fromOptions = this.options.iosWdaMjpegPort;
    if (Number.isFinite(fromOptions) && (fromOptions ?? 0) > 0) {
      return Math.floor(fromOptions!);
    }
    const envA = process.env.MIDSCENE_IOS_WDA_MJPEG_PORT?.trim();
    const envB = process.env.IOS_WDA_MJPEG_PORT?.trim();
    for (const raw of [envA, envB]) {
      if (!raw) continue;
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
    return wdaCommandPort + 1000;
  }

  private async getIosDevice(resourceId: ResourceId): Promise<IOSDevice> {
    const key = String(resourceId);
    const cached = this.iosDevices.get(key);
    if (cached) return cached;
    const pending = this.iosDeviceConnecting.get(key);
    if (pending) return pending;

    const creating = (async () => {
      const wdaHost = this.getIosWdaHost();
      const wdaPort = await resolveIosWdaPortForLiveDebug(this.commandRunner, this.buildIosWdaResolveParams(key));
      const mjpegPort = this.getIosWdaMjpegPort(wdaPort);
      const udid = extractIosUdidFromResourceId(key);
      const device = new IOSDevice({
        wdaHost,
        wdaPort,
        wdaMjpegPort: mjpegPort,
        ...(udid ? { deviceId: udid } : {}),
      });
      await device.connect();
      this.iosDevices.set(key, device);
      return device;
    })();

    this.iosDeviceConnecting.set(key, creating);
    try {
      return await creating;
    } finally {
      this.iosDeviceConnecting.delete(key);
    }
  }

  private normalizeWdaActiveAppValue(value: unknown): LiveDebugForegroundApp | undefined {
    if (!value || typeof value !== "object") return undefined;
    const o = value as Record<string, unknown>;
    const out: LiveDebugForegroundApp = {};
    if (typeof o.bundleId === "string" && o.bundleId.trim()) out.bundleId = o.bundleId.trim();
    if (typeof o.name === "string" && o.name.trim()) out.name = o.name.trim();
    if (typeof o.pid === "number" && Number.isFinite(o.pid)) out.pid = Math.floor(o.pid);
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /** Android：adb dumpsys 小片段，失败不抛错。 */
  private async fetchAndroidForegroundAppViaAdb(resourceId: ResourceId): Promise<LiveDebugForegroundApp | undefined> {
    const adbPrefix = this.buildAndroidAdbPrefix(resourceId);
    const innerCommands = [
      'dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity|ResumedActivity" | head -n 14',
      'dumpsys window | grep -E "mCurrentFocus|mFocusedApp" | head -n 18',
      "dumpsys activity top | head -n 80",
    ];
    for (const inner of innerCommands) {
      const cmd = `${adbPrefix} shell ${JSON.stringify(inner)}`;
      const result = await this.commandRunner.run(cmd, 4_000);
      if (!result.ok) continue;
      const parsed = parseAndroidForegroundFromDumpsys(result.stdout);
      if (parsed?.bundleId) return parsed;
    }
    return undefined;
  }

  /** 鸿蒙：aa / hidumper，失败不抛错。 */
  private async fetchHarmonyForegroundAppViaHdc(resourceId: ResourceId): Promise<LiveDebugForegroundApp | undefined> {
    try {
      const device = await this.getHarmonyDevice(resourceId);
      const hdc = await device.getHdc();
      const tryShell = async (cmd: string): Promise<LiveDebugForegroundApp | undefined> => {
        const out = await hdc.shell(cmd);
        if (typeof out === "string" && out.length < 600 && /error:/i.test(out)) return undefined;
        return parseHarmonyForegroundFromShellDump(out);
      };
      const cmds = ["aa dump -l", "hidumper -s WindowManagerService -a", "aa dump -a | head -n 500", "aa dump -a"];
      for (const cmd of cmds) {
        const v = await tryShell(cmd);
        if (v?.bundleId) return v;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /** iOS WDA `/wda/activeAppInfo`，失败不抛错。 */
  private async fetchIosForegroundAppFromWda(wdaHost: string, wdaPort: number): Promise<LiveDebugForegroundApp | undefined> {
    const url = `http://${wdaHost}:${wdaPort}/wda/activeAppInfo`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return undefined;
      const json = (await res.json()) as { value?: unknown };
      return this.normalizeWdaActiveAppValue(json?.value);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private async captureIosFrame(resourceId: ResourceId): Promise<{
    mimeType: string;
    dataBase64: string;
    sourceUri: string;
    foregroundApp?: LiveDebugForegroundApp;
  }> {
    const wdaHost = this.getIosWdaHost();
    const wdaCmdPort = await this.resolveIosWdaCommandPortForResource(resourceId);
    const mjpegPort = this.getIosWdaMjpegPort(wdaCmdPort);
    const token = extractIosUdidFromResourceId(String(resourceId));
    const fgPromise = this.fetchIosForegroundAppFromWda(wdaHost, wdaCmdPort);
    try {
      const jpeg = await captureFirstJpegFromWdaMjpegStream(wdaHost, mjpegPort, { timeoutMs: 8_000 });
      const foregroundApp = await fgPromise;
      return {
        mimeType: "image/jpeg",
        dataBase64: jpeg.toString("base64"),
        sourceUri: `mjpeg://${wdaHost}:${mjpegPort}/ios/${token}`,
        ...(foregroundApp ? { foregroundApp } : {}),
      };
    } catch (mjpegErr) {
      try {
        const device = await this.getIosDevice(resourceId);
        const dataUri = await device.screenshotBase64();
        const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) {
          throw new Error("ios screenshotBase64 returned unsupported data uri");
        }
        const foregroundApp = await fgPromise;
        return {
          mimeType: match[1],
          dataBase64: match[2],
          sourceUri: `wda://ios/${token}/latest-frame`,
          ...(foregroundApp ? { foregroundApp } : {}),
        };
      } catch (shotErr) {
        throw new Error(
          `iOS 实时看屏: MJPEG(${mjpegPort}) 失败: ${mjpegErr instanceof Error ? mjpegErr.message : String(mjpegErr)}；WebDriver 截图回退失败: ${shotErr instanceof Error ? shotErr.message : String(shotErr)}`,
        );
      }
    }
  }

  private async sendIosBackGesture(device: IOSDevice): Promise<void> {
    const { width, height } = await device.size();
    const y = Math.round(height / 2);
    const x1 = Math.max(8, Math.round(width * 0.02));
    const x2 = Math.min(Math.round(width * 0.35), Math.max(x1 + 40, 120));
    await device.swipe(x1, y, x2, y, 280);
  }

  private async sendIosInput(
    resourceId: ResourceId,
    input: LiveInputAction,
  ): Promise<{ output: string }> {
    const device = await this.getIosDevice(resourceId);
    if (input.action === "tap") {
      const point = await this.normalizeIosLivePoint(device, input.x, input.y, input);
      await device.tap(point.x, point.y);
      return { output: "ok" };
    }
    if (input.action === "swipe") {
      const durationMs =
        Number.isFinite(input.durationMs) && (input.durationMs ?? 0) > 0 ? Math.floor(input.durationMs!) : 300;
      const from = await this.normalizeIosLivePoint(device, input.x, input.y, input);
      const to = await this.normalizeIosLivePoint(device, input.x2, input.y2, input);
      await device.swipe(
        from.x,
        from.y,
        to.x,
        to.y,
        durationMs,
      );
      return { output: "ok" };
    }
    const raw = typeof input.key === "string" ? input.key.trim() : "";
    const upper = raw.toUpperCase();
    if (upper === "HOME" || upper === "KEYCODE_HOME" || raw === "3") {
      await device.home();
      return { output: "ok" };
    }
    if (upper === "APP_SWITCH" || upper === "RECENT" || raw === "187") {
      await device.appSwitcher();
      return { output: "ok" };
    }
    if (upper === "BACK" || upper === "KEYCODE_BACK" || raw === "4") {
      await this.sendIosBackGesture(device);
      return { output: "ok" };
    }
    if (raw) {
      // @ts-expect-error - pressKey is private on IOSDevice in current @midscene SDK
      await device.pressKey(raw);
    }
    return { output: "ok" };
  }

  private async normalizeIosLivePoint(
    device: IOSDevice,
    x: number,
    y: number,
    meta: LiveImageCoordinateMeta,
  ): Promise<{ x: number; y: number }> {
    if (
      meta.coordinateSpace !== "image" ||
      !Number.isFinite(meta.sourceWidth) ||
      !Number.isFinite(meta.sourceHeight) ||
      (meta.sourceWidth ?? 0) <= 0 ||
      (meta.sourceHeight ?? 0) <= 0
    ) {
      return { x: Math.round(x), y: Math.round(y) };
    }
    const { width, height } = await device.size();
    return {
      x: Math.round((x / meta.sourceWidth!) * width),
      y: Math.round((y / meta.sourceHeight!) * height),
    };
  }

  private harmonyDeviceCacheKey(resourceId: ResourceId): string {
    const host = this.options.harmonyHdcHost?.trim() ?? "";
    const port = Number.isFinite(this.options.harmonyHdcPort) && (this.options.harmonyHdcPort ?? 0) > 0 ? String(this.options.harmonyHdcPort) : "";
    return `${String(resourceId)}|${host}|${port}`;
  }

  private async getHarmonyDevice(resourceId: ResourceId): Promise<HarmonyDevice> {
    const key = this.harmonyDeviceCacheKey(resourceId);
    const cached = this.harmonyDevices.get(key);
    if (cached) return cached;
    const pending = this.harmonyDeviceConnecting.get(key);
    if (pending) return pending;

    const creating = (async () => {
      const device = await connectHarmonyAgentDebugDevice({
        resourceId: String(resourceId),
        harmonyHdcPath: this.options.harmonyHdcPath,
        harmonyHdcHost: this.options.harmonyHdcHost,
        harmonyHdcPort: this.options.harmonyHdcPort,
      });
      this.harmonyDevices.set(key, device);
      return device;
    })();

    this.harmonyDeviceConnecting.set(key, creating);
    try {
      return await creating;
    } finally {
      this.harmonyDeviceConnecting.delete(key);
    }
  }

  private async captureHarmonyFrame(resourceId: ResourceId): Promise<{
    mimeType: string;
    dataBase64: string;
    sourceUri: string;
    foregroundApp?: LiveDebugForegroundApp;
  }> {
    const fgPromise = this.fetchHarmonyForegroundAppViaHdc(resourceId);
    const device = await this.getHarmonyDevice(resourceId);
    const dataUri = await device.screenshotBase64();
    const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      throw new Error("harmony screenshotBase64 returned unsupported data uri");
    }
    const token = extractHarmonyDeviceIdFromResourceId(String(resourceId));
    const foregroundApp = await fgPromise;
    return {
      mimeType: match[1],
      dataBase64: match[2],
      sourceUri: `hdc://harmony/${token}/latest-frame`,
      ...(foregroundApp ? { foregroundApp } : {}),
    };
  }

  private async sendHarmonyInput(
    resourceId: ResourceId,
    input: LiveInputAction,
  ): Promise<{ output: string }> {
    const device = await this.getHarmonyDevice(resourceId);
    if (input.action === "tap") {
      // @ts-expect-error - tap() API changed in current @midscene SDK for HarmonyDevice
      await device.tap(Math.round(input.x), Math.round(input.y));
      return { output: "ok" };
    }
    if (input.action === "swipe") {
      const hdc = await device.getHdc();
      const durationMs =
        Number.isFinite(input.durationMs) && (input.durationMs ?? 0) > 0 ? Math.floor(input.durationMs!) : 300;
      await hdc.swipe(Math.round(input.x), Math.round(input.y), Math.round(input.x2), Math.round(input.y2), durationMs);
      return { output: "ok" };
    }
    const raw = typeof input.key === "string" ? input.key.trim() : "";
    const upper = raw.toUpperCase();
    if (upper === "BACK" || upper === "KEYCODE_BACK" || raw === "4") {
      await device.back();
      return { output: "ok" };
    }
    if (upper === "HOME" || upper === "KEYCODE_HOME" || raw === "3") {
      await device.home();
      return { output: "ok" };
    }
    if (upper === "APP_SWITCH" || upper === "RECENT" || raw === "187") {
      await device.recentApps();
      return { output: "ok" };
    }
    // @ts-expect-error - keyboardPress() API changed in current @midscene SDK for HarmonyDevice
    await device.keyboardPress(raw);
    return { output: "ok" };
  }

  private extractAndroidSerial(resourceId: ResourceId): string {
    const raw = String(resourceId);
    const idx = raw.indexOf(":");
    return idx >= 0 ? raw.slice(idx + 1) : raw;
  }

  private getAndroidAdbHost(): string {
    const fromOptions = this.options.androidAdbHost?.trim();
    if (fromOptions) return fromOptions;
    const fromEnv = process.env.MIDSCENE_ANDROID_ADB_HOST?.trim() || process.env.AGENT_ANDROID_ADB_HOST?.trim();
    return fromEnv || "127.0.0.1";
  }

  private getAndroidAdbPort(): number {
    const fromOptions = this.options.androidAdbPort;
    if (Number.isFinite(fromOptions) && (fromOptions ?? 0) > 0) return Math.floor(fromOptions!);
    const fromEnv = Number(process.env.MIDSCENE_ANDROID_ADB_PORT ?? process.env.AGENT_ANDROID_ADB_PORT ?? "5037");
    if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
    return 5037;
  }

  private buildAndroidAdbPrefix(resourceId: ResourceId): string {
    const serial = this.extractAndroidSerial(resourceId);
    const host = this.getAndroidAdbHost();
    const port = this.getAndroidAdbPort();
    return `adb -H ${JSON.stringify(host)} -P ${port} -s ${JSON.stringify(serial)}`;
  }

  private async getAndroidDevice(resourceId: ResourceId): Promise<AndroidDevice> {
    const serial = this.extractAndroidSerial(resourceId);
    const cached = this.androidDevices.get(serial);
    if (cached) return cached;
    const connecting = this.androidDeviceConnecting.get(serial);
    if (connecting) return connecting;

    const creating = (async () => {
      const device = new AndroidDevice(serial, {
        remoteAdbHost: this.getAndroidAdbHost(),
        remoteAdbPort: this.getAndroidAdbPort(),
        scrcpyConfig: {
          enabled: true,
          maxSize:
            Number.isFinite(this.options.androidScrcpyMaxSize) && (this.options.androidScrcpyMaxSize ?? -1) >= 0
              ? Math.floor(this.options.androidScrcpyMaxSize!)
              : 0,
          videoBitRate:
            Number.isFinite(this.options.androidScrcpyVideoBitRate) && (this.options.androidScrcpyVideoBitRate ?? 0) > 0
              ? Math.floor(this.options.androidScrcpyVideoBitRate!)
              : 40_000_000,
          idleTimeoutMs:
            Number.isFinite(this.options.androidScrcpyIdleTimeoutMs) && (this.options.androidScrcpyIdleTimeoutMs ?? 0) > 0
              ? Math.floor(this.options.androidScrcpyIdleTimeoutMs!)
              : 120_000,
        },
      });
      await device.connect();
      this.androidDevices.set(serial, device);
      return device;
    })();

    this.androidDeviceConnecting.set(serial, creating);
    try {
      return await creating;
    } finally {
      this.androidDeviceConnecting.delete(serial);
    }
  }

  private async captureAndroidFrame(resourceId: ResourceId): Promise<{
    mimeType: string;
    dataBase64: string;
    sourceUri: string;
    foregroundApp?: LiveDebugForegroundApp;
  }> {
    const fgPromise = this.fetchAndroidForegroundAppViaAdb(resourceId);
    try {
      const device = await this.getAndroidDevice(resourceId);
      const dataUri = await device.screenshotBase64();
      const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) {
        throw new Error("android screenshotBase64 returned unsupported data uri");
      }
      const foregroundApp = await fgPromise;
      return {
        mimeType: match[1],
        dataBase64: match[2],
        sourceUri: `scrcpy://${this.extractAndroidSerial(resourceId)}/latest-frame`,
        ...(foregroundApp ? { foregroundApp } : {}),
      };
    } catch (error) {
      // scrcpy 不可用时回退到 adb screencap，保证功能可用性
      const adbPrefix = this.buildAndroidAdbPrefix(resourceId);
      const command = `${adbPrefix} exec-out screencap -p | base64`;
      const result = await this.commandRunner.run(command, 10_000);
      if (!result.ok) {
        throw new Error(
          `android live frame capture failed (scrcpy + screencap fallback): ${
            error instanceof Error ? error.message : String(error)
          }; ${result.stderr || result.stdout}`,
        );
      }
      const dataBase64 = result.stdout.replace(/\s+/g, "");
      if (!dataBase64) {
        throw new Error("android live frame capture returned empty data");
      }
      const foregroundApp = await fgPromise;
      return {
        mimeType: "image/png",
        dataBase64,
        sourceUri: `adb://${this.extractAndroidSerial(resourceId)}/screencap`,
        ...(foregroundApp ? { foregroundApp } : {}),
      };
    }
  }

  private async sendAndroidInput(
    resourceId: ResourceId,
    input: LiveInputAction,
  ): Promise<{ output: string }> {
    const adbPrefix = this.buildAndroidAdbPrefix(resourceId);
    const command =
      input.action === "tap"
        ? `${adbPrefix} shell input tap ${Math.round(input.x)} ${Math.round(input.y)}`
        : input.action === "swipe"
          ? `${adbPrefix} shell input swipe ${Math.round(input.x)} ${Math.round(input.y)} ${Math.round(input.x2)} ${Math.round(input.y2)} ${Number.isFinite(input.durationMs) && (input.durationMs ?? 0) > 0 ? Math.floor(input.durationMs!) : 300}`
          : `${adbPrefix} shell input keyevent ${JSON.stringify(input.key)}`;
    const result = await this.commandRunner.run(command, 10_000);
    if (!result.ok) {
      throw new Error(`android live input failed: ${result.stderr || result.stdout}`);
    }
    return { output: result.stdout.trim() || "ok" };
  }

  private renderLiveInputCommand(input: LiveInputAction): string {
    if (input.action === "tap") {
      return `tap(${Math.round(input.x)},${Math.round(input.y)})`;
    }
    if (input.action === "swipe") {
      const durationMs = Number.isFinite(input.durationMs) && (input.durationMs ?? 0) > 0 ? Math.floor(input.durationMs!) : 300;
      return `swipe(${Math.round(input.x)},${Math.round(input.y)},${Math.round(input.x2)},${Math.round(input.y2)},${durationMs})`;
    }
    return `key(${JSON.stringify(input.key)})`;
  }
}
