import type { ResourceAdapter } from "../../adapter-spi/resource/index.js";
import { AdapterRegistry } from "../adapters/AdapterRegistry.js";
import { AndroidResourceAdapter } from "../adapters/android/AndroidResourceAdapter.js";
import { buildAndroidAdbCliPrefix, buildHarmonyHdcShellPrefix } from "../adapters/deviceDetailsProbe.js";
import { HarmonyResourceAdapter } from "../adapters/harmony/HarmonyResourceAdapter.js";
import { IOSResourceAdapter } from "../adapters/ios/IOSResourceAdapter.js";
import { ShellCommandExecutor, ShellSnapshotProvider } from "../adapters/real/ShellCommandAndSnapshot.js";
import { MidsceneRuntimeReal } from "../midscene/MidsceneRuntimeReal.js";
import { NodeCommandRunner } from "../system/CommandRunner.js";
import type { CommandRunner } from "../system/CommandRunner.js";
import type { MidsceneRuntime } from "../../domain/runtime/interfaces.js";
import path from "node:path";

/** 与 MidsceneRuntimeReal 同源 env，供 DebugRuntimeImpl 鸿蒙实时看屏使用 */
export interface HarmonyDebugHdcConfig {
  path?: string;
  host?: string;
  port?: number;
}

/** 与 MidsceneRuntimeReal 同源，供 DebugRuntimeImpl iOS 实时看屏解析 WDA 端口 */
export interface IosDebugWdaConfig {
  host: string;
  portMapFilePath: string;
  portRangeStart: number;
  portRangeEnd: number;
  /** MIDSCENE_IOS_WDA_PORT / IOS_WDA_PORT，单设备时可强制指定 */
  explicitWdaPort?: number;
  /**
   * 本机 MJPEG 端口（与 start-ios-wda 映射一致）。
   * 未设置时由 DebugRuntime 使用「解析到的 WDA 命令端口 + 1000」。
   */
  mjpegPort?: number;
}

export interface RuntimeContext {
  adapterRegistry: AdapterRegistry;
  midsceneRuntime: MidsceneRuntime;
  commandRunner: CommandRunner;
  selectedMode: "REAL";
  harmonyDebugHdc: HarmonyDebugHdcConfig;
  iosDebugWda: IosDebugWdaConfig;
}

export function buildRuntimeContext(env: NodeJS.ProcessEnv): RuntimeContext {
  const repoRoot = process.cwd();
  const commandRunner = new NodeCommandRunner();
  const harmonyDiscoveryCommand = env.HARMONY_DISCOVERY_COMMAND ?? "hdc list targets";
  const iosDiscoveryCommand = env.IOS_DISCOVERY_COMMAND ?? "xcrun xctrace list devices";
  const debugCommandTemplate = env.DEBUG_COMMAND_TEMPLATE ?? "echo '{command}'";
  const snapshotCommandTemplate =
    env.SNAPSHOT_COMMAND_TEMPLATE ?? "echo 'file:///tmp/automation-agent-snapshot-{resourceId}.png'";
  const defaultMidsceneRunner = path.join(repoRoot, "scripts", "run-midscene-task.sh");
  const midsceneRunCommand =
    env.MIDSCENE_RUN_COMMAND ?? `bash "${defaultMidsceneRunner}" "{scriptFile}"`;
  const midsceneRunTimeoutMs = Number(env.MIDSCENE_RUN_TIMEOUT_MS ?? "300000");
  const iosWdaPortRangeStart = Number(env.IOS_WDA_PORT_RANGE_START ?? "8200");
  const iosWdaPortRangeEnd = Number(env.IOS_WDA_PORT_RANGE_END ?? "8399");
  const iosWdaHealthUrlTemplate = env.IOS_WDA_HEALTH_URL_TEMPLATE ?? "http://127.0.0.1:{wdaPort}/status";
  const iosWdaHost = env.MIDSCENE_IOS_WDA_HOST?.trim() || env.IOS_WDA_HOST?.trim() || "127.0.0.1";
  const defaultWdaStartScript = path.join(repoRoot, "scripts", "start-ios-wda.sh");
  const iosWdaStartCommandTemplate =
    env.IOS_WDA_START_COMMAND_TEMPLATE?.trim() || `bash "${defaultWdaStartScript}" "{deviceId}" "{wdaPort}"`;
  const iosWdaPortMapFilePath = env.IOS_WDA_PORT_MAP_FILE_PATH?.trim() || path.join(repoRoot, ".wda-agent-state", "wda-port-map.json");
  const iosWdaStartupTimeoutMs = Number(env.IOS_WDA_STARTUP_TIMEOUT_MS ?? "120000");
  const iosWdaStartupRetry = Number(env.IOS_WDA_STARTUP_RETRY ?? "2");
  const androidAdbHost = env.MIDSCENE_ANDROID_ADB_HOST?.trim() || env.AGENT_ANDROID_ADB_HOST?.trim() || "127.0.0.1";
  const androidAdbPort = Number(env.MIDSCENE_ANDROID_ADB_PORT ?? env.AGENT_ANDROID_ADB_PORT ?? "5037");
  const androidDiscoveryCommand =
    env.ANDROID_DISCOVERY_COMMAND?.trim() ||
    `${buildAndroidAdbCliPrefix(androidAdbHost, androidAdbPort)} devices`;
  const harmonyHdcPath = env.MIDSCENE_HARMONY_HDC_PATH?.trim() || env.AGENT_HARMONY_HDC_PATH?.trim() || undefined;
  const harmonyHdcHost = env.MIDSCENE_HARMONY_HDC_HOST?.trim() || env.AGENT_HARMONY_HDC_HOST?.trim() || undefined;
  const harmonyHdcPortRaw = Number(env.MIDSCENE_HARMONY_HDC_PORT ?? env.AGENT_HARMONY_HDC_PORT ?? "");
  const harmonyHdcPortResolved =
    Number.isFinite(harmonyHdcPortRaw) && harmonyHdcPortRaw > 0 ? Math.floor(harmonyHdcPortRaw) : undefined;

  const iosWdaExplicitRaw = Number(env.MIDSCENE_IOS_WDA_PORT ?? env.IOS_WDA_PORT ?? "");
  const iosWdaExplicitResolved =
    Number.isFinite(iosWdaExplicitRaw) && iosWdaExplicitRaw > 0 ? Math.floor(iosWdaExplicitRaw) : undefined;

  const iosWdaMjpegPortRaw = env.MIDSCENE_IOS_WDA_MJPEG_PORT?.trim() || env.IOS_WDA_MJPEG_PORT?.trim() || "";
  const iosWdaMjpegPortParsed = Number(iosWdaMjpegPortRaw);
  const iosWdaMjpegPortResolved =
    iosWdaMjpegPortRaw !== "" && Number.isFinite(iosWdaMjpegPortParsed) && iosWdaMjpegPortParsed > 0
      ? Math.floor(iosWdaMjpegPortParsed)
      : undefined;

  const harmonyHdcShellPrefix = buildHarmonyHdcShellPrefix(harmonyHdcPath, harmonyHdcHost, harmonyHdcPortResolved);

  const resourceAdapters: ResourceAdapter[] = [
    new HarmonyResourceAdapter(commandRunner, harmonyDiscoveryCommand, harmonyHdcShellPrefix),
    new AndroidResourceAdapter(commandRunner, androidDiscoveryCommand, androidAdbHost, androidAdbPort),
    new IOSResourceAdapter(commandRunner, iosDiscoveryCommand),
  ];

  const adapterRegistry = new AdapterRegistry(
    resourceAdapters,
    new ShellCommandExecutor(commandRunner, debugCommandTemplate),
    new ShellSnapshotProvider(commandRunner, snapshotCommandTemplate),
  );

  const midsceneRuntime = new MidsceneRuntimeReal(commandRunner, midsceneRunCommand, {
    runCommandTimeoutMs:
      Number.isFinite(midsceneRunTimeoutMs) && midsceneRunTimeoutMs > 0 ? Math.floor(midsceneRunTimeoutMs) : 120_000,
    iosWdaPortRangeStart:
      Number.isFinite(iosWdaPortRangeStart) && iosWdaPortRangeStart > 0 ? Math.floor(iosWdaPortRangeStart) : 8200,
    iosWdaPortRangeEnd:
      Number.isFinite(iosWdaPortRangeEnd) && iosWdaPortRangeEnd > 0 ? Math.floor(iosWdaPortRangeEnd) : 8399,
    iosWdaHealthUrlTemplate,
    iosWdaHost,
    iosWdaStartCommandTemplate,
    iosWdaPortMapFilePath,
    iosWdaStartupTimeoutMs:
      Number.isFinite(iosWdaStartupTimeoutMs) && iosWdaStartupTimeoutMs > 0
        ? Math.floor(iosWdaStartupTimeoutMs)
        : 120_000,
    iosWdaStartupRetry: Number.isFinite(iosWdaStartupRetry) && iosWdaStartupRetry > 0 ? Math.floor(iosWdaStartupRetry) : 2,
    androidAdbHost,
    androidAdbPort: Number.isFinite(androidAdbPort) && androidAdbPort > 0 ? Math.floor(androidAdbPort) : 5037,
    harmonyHdcPath,
    harmonyHdcHost,
    harmonyHdcPort: harmonyHdcPortResolved,
  });

  return {
    adapterRegistry,
    midsceneRuntime,
    commandRunner,
    selectedMode: "REAL",
    harmonyDebugHdc: {
      path: harmonyHdcPath,
      host: harmonyHdcHost,
      port: harmonyHdcPortResolved,
    },
    iosDebugWda: {
      host: iosWdaHost,
      portMapFilePath: iosWdaPortMapFilePath,
      portRangeStart:
        Number.isFinite(iosWdaPortRangeStart) && iosWdaPortRangeStart > 0 ? Math.floor(iosWdaPortRangeStart) : 8200,
      portRangeEnd: Number.isFinite(iosWdaPortRangeEnd) && iosWdaPortRangeEnd > 0 ? Math.floor(iosWdaPortRangeEnd) : 8399,
      explicitWdaPort: iosWdaExplicitResolved,
      ...(iosWdaMjpegPortResolved != null ? { mjpegPort: iosWdaMjpegPortResolved } : {}),
    },
  };
}
