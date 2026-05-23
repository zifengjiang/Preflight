import { AgentCommandPollLoop } from "./application/agent/AgentCommandPollLoop.js";
import { AgentRuntimeService } from "./application/agent/AgentRuntimeService.js";
import { ArtifactApplicationService } from "./application/artifact/ArtifactApplicationService.js";
import { DebugApplicationService } from "./application/debug/DebugApplicationService.js";
import { HealthMetricsService } from "./application/health/HealthMetricsService.js";
import { LeaseApplicationService } from "./application/lease/LeaseApplicationService.js";
import { ObservationQueryService } from "./application/query/ObservationQueryService.js";
import { ReporterApplicationService } from "./application/reporter/ReporterApplicationService.js";
import { ResourceOccupationReleaseService } from "./application/resource/ResourceOccupationReleaseService.js";
import { ResourceRegistryService } from "./application/resource/ResourceRegistryService.js";
import { SessionApplicationService } from "./application/session/SessionApplicationService.js";
import { TaskApplicationService } from "./application/task/TaskApplicationService.js";
import { AppPackageApplicationService } from "./application/app-package/AppPackageApplicationService.js";
import { AppPackageUrlCache } from "./infrastructure/app-package/AppPackageUrlCache.js";
import { resolveAppPackageDownloadDir } from "./infrastructure/app-package/appPackageDownloadDir.js";
import { DebugRuntimeImpl } from "./infrastructure/midscene/DebugRuntimeImpl.js";
import { DeviceAppPackageOps } from "./infrastructure/device/DeviceAppPackageOps.js";
import { buildRuntimeContext } from "./infrastructure/bootstrap/BuildRuntimeContext.js";
import { parsePositiveByteCount, startDirCapacityWatchdog } from "./infrastructure/cache/DirCapacityWatchdog.js";
import { IOSWdaWatchdog } from "./infrastructure/ios/IOSWdaWatchdog.js";
import { getMidsceneReportRootDir } from "./infrastructure/transport/midscenePaths.js";
import {
  InMemoryAgentRepository,
  InMemoryArtifactRepository,
  InMemoryEventRepository,
  InMemoryLeaseRepository,
  InMemoryResourceRepository,
  InMemorySessionRepository,
  InMemoryTaskRepository,
} from "./infrastructure/persistence/InMemoryRepositories.js";
import { AgentEventHttpIngestClient } from "./infrastructure/transport/http/AgentEventHttpIngestClient.js";
import { WsClient } from "./infrastructure/transport/ws/WsClient.js";
import { ResilientWsOrHttpEventPublisher } from "./infrastructure/transport/ws/ResilientWsOrHttpEventPublisher.js";
import { WsEventPublisher } from "./infrastructure/transport/ws/WsEventPublisher.js";
import { PlatformCommandPollClient } from "./infrastructure/transport/http/PlatformCommandPollClient.js";
import { PlatformCallbackClient } from "./infrastructure/transport/http/PlatformCallbackClient.js";
import { CallbackOutboxStore } from "./infrastructure/transport/http/CallbackOutboxStore.js";
import { ResilientPlatformCallbackClient } from "./infrastructure/transport/http/ResilientPlatformCallbackClient.js";
import { HttpServer } from "./interfaces/http/HttpServer.js";
import { AgentWsGateway } from "./interfaces/websocket/AgentWsGateway.js";
import { EventType } from "./shared-kernel/enums/index.js";
import {
  applyAgentConfigFileToProcessEnv,
  applyMutualAgentAuthTokenFallbackToProcessEnv,
} from "./infrastructure/config/agentConfigFile.js";
import { isIPv4 } from "node:net";
import os from "node:os";
import path from "node:path";

applyAgentConfigFileToProcessEnv();
applyMutualAgentAuthTokenFallbackToProcessEnv();

if ((process.env.LOCAL_MCP_MODE ?? "").trim() === "1") {
  process.env.AGENT_HTTP_TOKEN = "";
  process.env.PLATFORM_WS_TOKEN = "";
  process.env.PLATFORM_AGENT_CALLBACK_TOKEN = "";
  process.env.PLATFORM_CALLBACK_ENDPOINT = "";
  process.env.PLATFORM_COMMAND_POLL_BASE_URL = "";
  process.env.PLATFORM_AGENT_EVENTS_HTTP_BASE_URL = "";
}

const rawPlatformWsEndpoint = process.env.PLATFORM_WS_ENDPOINT ?? "ws://127.0.0.1:18999";
const httpPort = Number(process.env.AGENT_HTTP_PORT ?? "18998");
const agentId = process.env.AGENT_ID ?? "agent-local-1";
const localMcpMode = (process.env.LOCAL_MCP_MODE ?? "").trim() === "1";

function pickAdvertiseHost(): string {
  const env = process.env.AGENT_ADVERTISE_HOST?.trim();
  if (env) return env;
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    const addrs = nets[name];
    if (!addrs) continue;
    for (const a of addrs) {
      if (!a.internal && isIPv4(a.address)) {
        return a.address;
      }
    }
  }
  return "127.0.0.1";
}

const advertiseHost = pickAdvertiseHost();

/** 经 `AgentSocketPresence` 上报，供平台「运行系统」列展示 */
const agentSocketOs = os.type();
const agentSocketPlatform = `${process.platform}/${process.arch}`;

/** 测试服务等多连接场景：若 URL 未带 agentId，则附加 AGENT_ID，便于与 /ws/agent?agentId= 对齐 */
function platformWsEndpointWithAgentIdQuery(endpoint: string, id: string): string {
  try {
    const u = new URL(endpoint);
    if (!u.searchParams.get("agentId")?.trim() && id.trim()) {
      u.searchParams.set("agentId", id.trim());
    }
    return u.toString();
  } catch {
    return endpoint;
  }
}

const wsEndpoint = platformWsEndpointWithAgentIdQuery(rawPlatformWsEndpoint, agentId);
const resourcesRefreshIntervalMs = Number(process.env.RESOURCES_REFRESH_INTERVAL_MS ?? "5000");
const httpAuthToken = process.env.AGENT_HTTP_TOKEN?.trim() || undefined;
const wsAuthToken = process.env.PLATFORM_WS_TOKEN?.trim() || httpAuthToken;
const platformCallbackEndpoint = process.env.PLATFORM_CALLBACK_ENDPOINT?.trim() || undefined;
const platformCallbackToken = process.env.PLATFORM_AGENT_CALLBACK_TOKEN?.trim() || httpAuthToken;
const platformCallbackFallbackEndpoint = process.env.PLATFORM_CALLBACK_FALLBACK_ENDPOINT?.trim() || undefined;
const platformCallbackFallbackToken = process.env.PLATFORM_CALLBACK_FALLBACK_TOKEN?.trim() || undefined;
const platformAgentEventsHttpBaseUrl = process.env.PLATFORM_AGENT_EVENTS_HTTP_BASE_URL?.trim() || undefined;
const debugAndroidAdbHost =
  process.env.MIDSCENE_ANDROID_ADB_HOST?.trim() || process.env.AGENT_ANDROID_ADB_HOST?.trim() || "127.0.0.1";
const debugAndroidAdbPort = Number(process.env.MIDSCENE_ANDROID_ADB_PORT ?? process.env.AGENT_ANDROID_ADB_PORT ?? "5037");
const debugAndroidScrcpyMaxSize = Number(process.env.MIDSCENE_ANDROID_SCRCPY_MAX_SIZE ?? "0");
const debugAndroidScrcpyVideoBitRate = Number(process.env.MIDSCENE_ANDROID_SCRCPY_VIDEO_BIT_RATE ?? "40000000");
const debugAndroidScrcpyIdleTimeoutMs = Number(process.env.MIDSCENE_ANDROID_SCRCPY_IDLE_TIMEOUT_MS ?? "120000");
const repoRoot = process.cwd();
const iosWdaStartCommandTemplate =
  process.env.IOS_WDA_START_COMMAND_TEMPLATE?.trim() ||
  `bash "${path.join(repoRoot, "scripts", "start-ios-wda.sh")}" "{deviceId}" "{wdaPort}"`;
const iosWdaStopCommand =
  process.env.IOS_WDA_STOP_COMMAND?.trim() || `bash "${path.join(repoRoot, "scripts", "stop-ios-wda.sh")}"`;
const iosWdaDiscoveryCommand = process.env.IOS_DISCOVERY_COMMAND ?? "xcrun xctrace list devices";
const iosWdaWatchdogEnabled = (process.env.IOS_WDA_WATCHDOG_ENABLED ?? "1").trim() !== "0";
const iosWdaWatchdogIntervalMs = Number(process.env.IOS_WDA_WATCHDOG_INTERVAL_MS ?? "5000");
const iosWdaStartupTimeoutMs = Number(process.env.IOS_WDA_STARTUP_TIMEOUT_MS ?? "120000");
const iosWdaPortRangeStart = Number(process.env.IOS_WDA_PORT_RANGE_START ?? "8200");
const iosWdaPortRangeEnd = Number(process.env.IOS_WDA_PORT_RANGE_END ?? "8399");
const iosWdaPortMapFilePath =
  process.env.IOS_WDA_PORT_MAP_FILE_PATH?.trim() || path.join(repoRoot, ".wda-agent-state", "wda-port-map.json");
const platformCommandPollBaseUrl = process.env.PLATFORM_COMMAND_POLL_BASE_URL?.trim() || undefined;
const commandPollIntervalMs = Number(process.env.COMMAND_POLL_INTERVAL_MS ?? "3000");
const wsReconnectBackoffMinMs = Number(process.env.WS_RECONNECT_BACKOFF_MIN_MS ?? "2000");
const wsReconnectBackoffMaxMs = Number(process.env.WS_RECONNECT_BACKOFF_MAX_MS ?? "60000");
const wsPendingQueueMaxItems = Number(process.env.WS_PENDING_QUEUE_MAX_ITEMS ?? "10000");
const appInstallTimeoutMs = Number(process.env.AGENT_APP_INSTALL_TIMEOUT_MS ?? "600000");
const appUninstallTimeoutMs = Number(process.env.AGENT_APP_UNINSTALL_TIMEOUT_MS ?? "120000");
const appAutoLeaseTtlSeconds = Number(process.env.AGENT_APP_AUTO_LEASE_TTL_SECONDS ?? "300");
const cacheWatchdogEnabled = (process.env.CACHE_WATCHDOG_ENABLED ?? "0").trim() === "1";
const cacheWatchdogIntervalMs = Number(process.env.CACHE_WATCHDOG_INTERVAL_MS ?? "3600000");

let appStopping = false;
let cacheWatchdogStop: (() => void) | undefined;

async function bootstrap(): Promise<void> {
  const agentRepo = new InMemoryAgentRepository();
  const resourceRepo = new InMemoryResourceRepository();
  const leaseRepo = new InMemoryLeaseRepository();
  const sessionRepo = new InMemorySessionRepository();
  const taskRepo = new InMemoryTaskRepository();
  const artifactRepo = new InMemoryArtifactRepository();
  const eventRepo = new InMemoryEventRepository();

  const runtimeContext = buildRuntimeContext(process.env);
  const adapterRegistry = runtimeContext.adapterRegistry;

  const outbox = new CallbackOutboxStore();
  const rawCallbackClient = new PlatformCallbackClient({
    endpoint: platformCallbackEndpoint,
    authToken: platformCallbackToken || wsAuthToken,
  });
  const fallbackCallbackClient = platformCallbackFallbackEndpoint
    ? new PlatformCallbackClient({
        endpoint: platformCallbackFallbackEndpoint,
        authToken: platformCallbackFallbackToken || platformCallbackToken || wsAuthToken,
      })
    : undefined;
  const callbackForTasks = new ResilientPlatformCallbackClient(rawCallbackClient, fallbackCallbackClient, outbox);

  if (!platformCallbackEndpoint) {
    console.warn(
      "[main] PLATFORM_CALLBACK_ENDPOINT 未设置：HTTP 回调（状态 / 日志 / 报告）已禁用；仅连接 WS 时也无法投递平台侧回调。",
    );
  } else if (!platformCallbackToken?.trim() && !wsAuthToken?.trim() && !httpAuthToken?.trim()) {
    console.warn(
      "[main] AGENT_HTTP_TOKEN / PLATFORM_WS_TOKEN / PLATFORM_AGENT_CALLBACK_TOKEN 均未设置：回调请求无 Bearer，平台将返回 401。",
    );
  }

  const health = new HealthMetricsService();
  let wsClient: WsClient;
  wsClient = new WsClient({
    endpoint: wsEndpoint,
    heartbeatMs: 5000,
    reconnectMs: 2000,
    reconnectBackoffMinMs:
      Number.isFinite(wsReconnectBackoffMinMs) && wsReconnectBackoffMinMs > 0 ? Math.floor(wsReconnectBackoffMinMs) : 2000,
    reconnectBackoffMaxMs:
      Number.isFinite(wsReconnectBackoffMaxMs) && wsReconnectBackoffMaxMs > 0 ? Math.floor(wsReconnectBackoffMaxMs) : 60_000,
    pendingQueueMaxItems:
      Number.isFinite(wsPendingQueueMaxItems) && wsPendingQueueMaxItems > 0 ? Math.floor(wsPendingQueueMaxItems) : 10_000,
    authToken: wsAuthToken,
    onOpen: () => {
      void callbackForTasks.flushOutbox();
      void wsClient.send(
        JSON.stringify({
          type: "AgentSocketPresence",
          agentId,
          advertiseHost,
          httpListenPort: httpPort,
          os: agentSocketOs,
          platform: agentSocketPlatform,
        }),
      );
    },
    onConnectionState: (state) => health.setWsConnectionState(state),
    onPendingDepth: (depth) => health.setPendingSendDepth(depth),
    onReconnectScheduled: (delayMs) => health.onReconnectScheduled(delayMs),
    onPendingDropped: (count) => health.onPendingDropped(count),
  });
  const eventHttpIngest = new AgentEventHttpIngestClient({
    baseUrl: platformAgentEventsHttpBaseUrl,
    agentId,
    authToken: platformCallbackToken || wsAuthToken,
  });
  const wsPublisherCore = new WsEventPublisher(wsClient);
  const publisher = localMcpMode
    ? {
        publish: async () => {},
        publishLiveDebugFrame: async () => {},
      }
    : new ResilientWsOrHttpEventPublisher(wsClient, wsPublisherCore, eventHttpIngest);
  const reporter = new ReporterApplicationService(eventRepo, publisher);
  const resourceService = new ResourceRegistryService(
    resourceRepo,
    adapterRegistry.resourceAdapters,
    reporter,
    leaseRepo,
    taskRepo,
    sessionRepo,
  );
  const leaseService = new LeaseApplicationService(leaseRepo, reporter);
  const sessionService = new SessionApplicationService(sessionRepo);
  const artifactService = new ArtifactApplicationService(artifactRepo);
  const taskService = new TaskApplicationService(
    taskRepo,
    resourceRepo,
    leaseService,
    sessionService,
    artifactService,
    reporter,
    runtimeContext.midsceneRuntime,
    callbackForTasks,
    agentId,
    process.env.TASK_AGENT_HTTP_BASE_URL?.trim() ||
      `http://127.0.0.1:${Number.isFinite(httpPort) && httpPort > 0 ? Math.floor(httpPort) : 18998}`,
    process.env.TASK_AGENT_HTTP_TOKEN?.trim() || httpAuthToken || undefined,
  );
  const debugService = new DebugApplicationService(
    leaseService,
    sessionService,
    new DebugRuntimeImpl(adapterRegistry.commandExecutor, adapterRegistry.snapshotProvider, runtimeContext.commandRunner, {
      androidAdbHost: debugAndroidAdbHost,
      androidAdbPort: Number.isFinite(debugAndroidAdbPort) && debugAndroidAdbPort > 0 ? Math.floor(debugAndroidAdbPort) : 5037,
      androidScrcpyMaxSize:
        Number.isFinite(debugAndroidScrcpyMaxSize) && debugAndroidScrcpyMaxSize >= 0
          ? Math.floor(debugAndroidScrcpyMaxSize)
          : 0,
      androidScrcpyVideoBitRate:
        Number.isFinite(debugAndroidScrcpyVideoBitRate) && debugAndroidScrcpyVideoBitRate > 0
          ? Math.floor(debugAndroidScrcpyVideoBitRate)
          : 40_000_000,
      androidScrcpyIdleTimeoutMs:
        Number.isFinite(debugAndroidScrcpyIdleTimeoutMs) && debugAndroidScrcpyIdleTimeoutMs > 0
          ? Math.floor(debugAndroidScrcpyIdleTimeoutMs)
          : 120_000,
      harmonyHdcPath: runtimeContext.harmonyDebugHdc.path,
      harmonyHdcHost: runtimeContext.harmonyDebugHdc.host,
      harmonyHdcPort: runtimeContext.harmonyDebugHdc.port,
      iosWdaHost: runtimeContext.iosDebugWda.host,
      iosWdaPortMapFilePath: runtimeContext.iosDebugWda.portMapFilePath,
      iosWdaPortRangeStart: runtimeContext.iosDebugWda.portRangeStart,
      iosWdaPortRangeEnd: runtimeContext.iosDebugWda.portRangeEnd,
      iosWdaExplicitPort: runtimeContext.iosDebugWda.explicitWdaPort,
      iosWdaMjpegPort: runtimeContext.iosDebugWda.mjpegPort,
    }),
    reporter,
  );
  const appPackageOps = new DeviceAppPackageOps(runtimeContext.commandRunner, {
    ideviceinstallerExe: process.env.IOS_IDEVICEINSTALLER_EXE?.trim() || undefined,
    adbHost: debugAndroidAdbHost,
    adbPort: Number.isFinite(debugAndroidAdbPort) && debugAndroidAdbPort > 0 ? Math.floor(debugAndroidAdbPort) : 5037,
    harmonyHdcPath: runtimeContext.harmonyDebugHdc.path,
    harmonyHdcHost: runtimeContext.harmonyDebugHdc.host,
    harmonyHdcPort: runtimeContext.harmonyDebugHdc.port,
  });
  const appPackageDownloadDir = resolveAppPackageDownloadDir(process.env.AGENT_APP_DOWNLOAD_DIR);
  const appPackageUrlCache = new AppPackageUrlCache({
    downloadDir: appPackageDownloadDir,
    agentId,
    onChanged: async (payload) => {
      try {
        await reporter.emit(EventType.APP_PACKAGE_CACHE_CHANGED, {
          agentId: payload.agentId,
          items: payload.items.map((i) => ({
            url: i.url,
            platform: i.platform,
            localPath: i.localPath,
            byteSize: i.byteSize,
            downloadedAt: i.downloadedAt,
          })),
        });
      } catch (err) {
        console.warn(
          `[main] APP_PACKAGE_CACHE_CHANGED emit failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  });
  await appPackageUrlCache.bootstrap();

  const appPackageService = new AppPackageApplicationService(leaseService, resourceRepo, appPackageOps, {
    downloadDir: appPackageDownloadDir,
    installTimeoutMs:
      Number.isFinite(appInstallTimeoutMs) && appInstallTimeoutMs > 0 ? Math.floor(appInstallTimeoutMs) : undefined,
    uninstallTimeoutMs:
      Number.isFinite(appUninstallTimeoutMs) && appUninstallTimeoutMs > 0 ? Math.floor(appUninstallTimeoutMs) : undefined,
    autoLeaseTtlSeconds:
      Number.isFinite(appAutoLeaseTtlSeconds) && appAutoLeaseTtlSeconds > 0 ? Math.floor(appAutoLeaseTtlSeconds) : undefined,
    urlCache: appPackageUrlCache,
  });
  const agentRuntime = new AgentRuntimeService(agentRepo, reporter);
  const observationQueryService = new ObservationQueryService(
    taskRepo,
    sessionRepo,
    leaseRepo,
    artifactRepo,
    eventRepo,
  );
  const occupationRelease = new ResourceOccupationReleaseService(
    taskService,
    debugService,
    leaseService,
    sessionRepo,
    taskRepo,
  );
  const gateway = new AgentWsGateway(
    wsClient,
    leaseService,
    taskService,
    debugService,
    appPackageService,
    occupationRelease,
  );
  const pollClient = new PlatformCommandPollClient({
    baseUrl: platformCommandPollBaseUrl,
    agentId,
    authToken: platformCallbackToken || wsAuthToken,
  });
  const commandPollLoop = new AgentCommandPollLoop(
    pollClient,
    gateway,
    wsClient,
    health,
    Number.isFinite(commandPollIntervalMs) && commandPollIntervalMs > 0 ? Math.floor(commandPollIntervalMs) : 3000,
  );
  const httpServer = new HttpServer(
    resourceService,
    observationQueryService,
    health,
    httpPort,
    httpAuthToken,
    agentId,
    leaseService,
    taskService,
    appPackageService,
    occupationRelease,
    appPackageUrlCache,
  );
  const iosWdaWatchdog = iosWdaWatchdogEnabled
    ? new IOSWdaWatchdog(runtimeContext.commandRunner, {
        discoveryCommand: iosWdaDiscoveryCommand,
        startCommandTemplate: iosWdaStartCommandTemplate,
        stopCommand: iosWdaStopCommand,
        intervalMs: Number.isFinite(iosWdaWatchdogIntervalMs) && iosWdaWatchdogIntervalMs > 0 ? Math.floor(iosWdaWatchdogIntervalMs) : 5_000,
        startupTimeoutMs: Number.isFinite(iosWdaStartupTimeoutMs) && iosWdaStartupTimeoutMs > 0 ? Math.floor(iosWdaStartupTimeoutMs) : 120_000,
        portRangeStart: Number.isFinite(iosWdaPortRangeStart) && iosWdaPortRangeStart > 0 ? Math.floor(iosWdaPortRangeStart) : 8200,
        portRangeEnd: Number.isFinite(iosWdaPortRangeEnd) && iosWdaPortRangeEnd > 0 ? Math.floor(iosWdaPortRangeEnd) : 8399,
        stateFilePath: iosWdaPortMapFilePath,
      })
    : null;

  if (iosWdaWatchdog) {
    void iosWdaWatchdog.start().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[main] ios watchdog start failed: ${message}`);
    });
  }

  if (cacheWatchdogEnabled) {
    const maxBytes = parsePositiveByteCount(process.env.CACHE_WATCHDOG_MAX_BYTES?.trim());
    if (maxBytes <= 0) {
      console.warn(
        "[main] CACHE_WATCHDOG_ENABLED=1 但 CACHE_WATCHDOG_MAX_BYTES 无效（示例：5368709120 或 5G），已跳过磁盘缓存 watchdog",
      );
    } else {
      const rootsFromEnv = process.env.CACHE_WATCHDOG_ROOTS?.trim();
      const defaultRoots = [getMidsceneReportRootDir(repoRoot)];
      const downloadDir = resolveAppPackageDownloadDir(process.env.AGENT_APP_DOWNLOAD_DIR);
      if (downloadDir) {
        defaultRoots.push(downloadDir);
      }
      const roots =
        rootsFromEnv && rootsFromEnv.length > 0
          ? rootsFromEnv.split(",").map((s) => s.trim()).filter(Boolean)
          : defaultRoots;
      const interval =
        Number.isFinite(cacheWatchdogIntervalMs) && cacheWatchdogIntervalMs >= 10_000
          ? Math.floor(cacheWatchdogIntervalMs)
          : 3_600_000;
      cacheWatchdogStop = startDirCapacityWatchdog({
        roots,
        maxBytes,
        intervalMs: interval,
        log: (line) => {
          console.info(line);
        },
      }).stop;
      console.info(
        `[main] 磁盘缓存 watchdog 已启用：每 ${interval}ms 巡检；各 root 独立上限 ${maxBytes} 字节；roots=${roots.join(",")}`,
      );
    }
  }

  await resourceService.refresh();
  if (!localMcpMode) {
    await agentRuntime.register(agentId);
    gateway.start();
    commandPollLoop.start();
  } else {
    console.info("[main] LOCAL_MCP_MODE=1：平台 WS、命令轮询和平台回调已禁用，仅保留本地 HTTP / 设备 / 任务能力。");
  }
  httpServer.start();
  if (!localMcpMode) {
    setInterval(async () => {
      try {
        await agentRuntime.heartbeat();
        health.markHeartbeat();
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      }
    }, 5000);
  }
  setInterval(async () => {
    try {
      await resourceService.refresh();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }, resourcesRefreshIntervalMs);
  setInterval(
    () => {
      void callbackForTasks.flushOutbox();
    },
    (() => {
      const raw = Number(process.env.CALLBACK_OUTBOX_INTERVAL_MS ?? "120000");
      return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 120_000;
    })(),
  );

  const shutdown = async (signal: string): Promise<void> => {
    if (appStopping) return;
    appStopping = true;
    console.info(`[main] shutting down, signal=${signal}`);
    if (iosWdaWatchdog) {
      await iosWdaWatchdog.stop();
    }
    cacheWatchdogStop?.();
    commandPollLoop.stop();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

void bootstrap();
