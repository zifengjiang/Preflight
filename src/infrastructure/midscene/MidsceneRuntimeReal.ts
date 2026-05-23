import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  MidsceneExecuteContext,
  MidsceneExecutionResult,
  MidsceneRuntime,
  MidsceneTaskReportInfo,
} from "../../domain/runtime/interfaces.js";
import type { TaskSpec } from "../../domain/task/TaskSpec.js";
import { ArtifactType, PlatformType } from "../../shared-kernel/enums/index.js";
import type { ResourceId } from "../../shared-kernel/ids/index.js";
import { wrapAndroidTaskScript } from "../../utils/wrapper/wrapAndroidTaskScript.ts";
import { wrapHarmonyTaskScript } from "../../utils/wrapper/wrapHarmonyTaskScript.ts";
import { wrapIosTaskScript } from "../../utils/wrapper/wrapIosTaskScript.ts";
import type { CommandRunner } from "../system/CommandRunner.js";
import { getMidsceneReportRootDir, resolveMidsceneRunDir, resolveTaskReportFilePaths } from "../transport/midscenePaths.js";
import { startExecutionDumpWatcher } from "./executionDumpWatcher.js";
import { zipDirectoryToFile } from "./zipReportDir.js";
import { resolveVideoRecorderConfig, startVideoRecording } from "./videoRecorder.js";
import { AirtestRuntime } from "../airtest/AirtestRuntime.js";

const WDA_ALREADY_DEBUGGING_EXIT_CODE = 20;
const DEFAULT_ANDROID_ADB_HOST = "127.0.0.1";
const DEFAULT_ANDROID_ADB_PORT = 5037;
const DEFAULT_IOS_WDA_HOST = "127.0.0.1";

interface PreparedMidsceneSession {
  platform: PlatformType;
  runtimeEnv: Record<string, string>;
  preparedAt: number;
}

interface WdaPortMapState {
  version?: number;
  updatedAt?: string;
  portsByUdid?: Record<string, number | string>;
}

function renderMidsceneCommand(template: string, resourceId: string, scriptFile: string): string {
  return template.replaceAll("{resourceId}", resourceId).replaceAll("{scriptFile}", scriptFile);
}

function extractDeviceToken(resourceId: string): string {
  const idx = resourceId.indexOf(":");
  return idx >= 0 ? resourceId.slice(idx + 1) : resourceId;
}

function pickNonEmptyString(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function toPositivePort(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} is required and must be a positive number`);
  }
  return Math.floor(parsed);
}

function renderTemplate(template: string, resourceId: string, wdaPort: number): string {
  const deviceId = extractDeviceToken(resourceId);
  return template
    .replaceAll("{resourceId}", resourceId)
    .replaceAll("{deviceId}", deviceId)
    .replaceAll("{wdaPort}", String(wdaPort));
}

function numberFromEnv(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = Number(env[key]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

function truthyFromEnv(env: Record<string, string | undefined>, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("cancelled");
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface MidsceneRuntimeRealOptions {
  runCommandTimeoutMs: number;
  iosWdaPortRangeStart: number;
  iosWdaPortRangeEnd: number;
  iosWdaHealthUrlTemplate: string;
  iosWdaHost?: string;
  iosWdaStartCommandTemplate?: string;
  iosWdaPortMapFilePath?: string;
  iosWdaStartupTimeoutMs: number;
  iosWdaStartupRetry: number;
  androidAdbHost?: string;
  androidAdbPort?: number;
  harmonyHdcPath?: string;
  harmonyHdcHost?: string;
  harmonyHdcPort?: number;
}

export class MidsceneRuntimeReal implements MidsceneRuntime {
  private readonly resourceWdaPort = new Map<string, number>();
  private readonly preparedSessions = new Map<string, PreparedMidsceneSession>();
  private readonly airtestRuntime: AirtestRuntime;

  constructor(
    private readonly commandRunner: CommandRunner,
    private readonly runCommandTemplate: string,
    private readonly options: MidsceneRuntimeRealOptions,
  ) {
    this.airtestRuntime = new AirtestRuntime(commandRunner, {
      runCommandTimeoutMs: options.runCommandTimeoutMs,
      androidAdbHost: options.androidAdbHost,
      androidAdbPort: options.androidAdbPort,
      iosWdaHost: options.iosWdaHost,
      harmonyHdcPath: options.harmonyHdcPath,
    });
  }

  private async canBindPort(port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.unref();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve(true));
      });
    });
  }

  private normalizePortRange(): { start: number; end: number } {
    const fallbackStart = 8200;
    const fallbackEnd = 8399;
    const start =
      Number.isFinite(this.options.iosWdaPortRangeStart) && this.options.iosWdaPortRangeStart > 0
        ? Math.floor(this.options.iosWdaPortRangeStart)
        : fallbackStart;
    const end =
      Number.isFinite(this.options.iosWdaPortRangeEnd) && this.options.iosWdaPortRangeEnd > 0
        ? Math.floor(this.options.iosWdaPortRangeEnd)
        : fallbackEnd;
    return start <= end ? { start, end } : { start: end, end: start };
  }

  private async resolveWdaStartupPortCandidate(resourceId: ResourceId): Promise<number> {
    const { start, end } = this.normalizePortRange();
    const usedByOthers = new Set(
      Array.from(this.resourceWdaPort.entries())
        .filter(([rid]) => rid !== resourceId)
        .map(([, port]) => port),
    );
    for (let port = start; port <= end; port += 1) {
      if (usedByOthers.has(port)) continue;
      if (!(await this.canBindPort(port))) continue;
      return port;
    }
    throw new Error(`no available WDA port in range ${start}-${end}`);
  }

  private async isWdaHealthy(resourceId: string, wdaPort: number, timeoutMs = 2_000): Promise<boolean> {
    const url = `http://127.0.0.1:${wdaPort}/status`
    const curlTimeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
    const escapedUrl = JSON.stringify(url);
    const command = `curl -fsS --max-time ${curlTimeoutSeconds} ${escapedUrl}`;
    const result = await this.commandRunner.run(command, timeoutMs + 500);
    if (!result.ok) return false;
    return result.stdout.trim().length > 0;
  }

  private async findHealthyWdaPortInRange(resourceId: ResourceId, signal?: AbortSignal): Promise<number | undefined> {
    const cachedPort = this.resourceWdaPort.get(resourceId);
    if (cachedPort != null && (await this.isWdaHealthy(resourceId, cachedPort))) {
      return cachedPort;
    }
    const { start, end } = this.normalizePortRange();
    for (let port = start; port <= end; port += 1) {
      if (signal?.aborted) throw new Error("cancelled");
      if (await this.isWdaHealthy(resourceId, port, 300)) {
        return port;
      }
    }
    return undefined;
  }

  private async readMappedWdaPort(resourceId: ResourceId): Promise<number | undefined> {
    const mapFilePath = this.options.iosWdaPortMapFilePath?.trim();
    if (!mapFilePath) return undefined;
    try {
      const raw = await readFile(mapFilePath, "utf8");
      const parsed = JSON.parse(raw) as WdaPortMapState;
      const udid = extractDeviceToken(resourceId);
      const portRaw = parsed.portsByUdid?.[udid];
      const port = Number(portRaw);
      if (!Number.isFinite(port) || port <= 0) return undefined;
      return Math.floor(port);
    } catch {
      return undefined;
    }
  }

  private getIosWdaHost(): string {
    const host = this.options.iosWdaHost?.trim();
    return host ? host : DEFAULT_IOS_WDA_HOST;
  }

  private getAndroidAdbHost(): string {
    const host = this.options.androidAdbHost?.trim();
    return host ? host : DEFAULT_ANDROID_ADB_HOST;
  }

  private getAndroidAdbPort(): number {
    const port = this.options.androidAdbPort;
    if (Number.isFinite(port) && port! > 0) return Math.floor(port!);
    return DEFAULT_ANDROID_ADB_PORT;
  }

  private buildIosRuntimeEnv(resourceId: ResourceId, wdaPort: number): Record<string, string> {
    const deviceId = extractDeviceToken(resourceId);
    const wdaHost = this.getIosWdaHost();
    return {
      MIDSCENE_PLATFORM: "ios",
      MIDSCENE_DEVICE_ID: deviceId,
      MIDSCENE_IOS_DEVICE_ID: deviceId,
      MIDSCENE_IOS_WDA_HOST: wdaHost,
      MIDSCENE_IOS_WDA_PORT: String(wdaPort),
      IOS_WDA_PORT: String(wdaPort),
    };
  }

  private buildAndroidRuntimeEnv(resourceId: ResourceId): Record<string, string> {
    const serial = extractDeviceToken(resourceId);
    return {
      MIDSCENE_PLATFORM: "android",
      MIDSCENE_DEVICE_ID: serial,
      MIDSCENE_ANDROID_SERIAL: serial,
      MIDSCENE_ANDROID_ADB_HOST: this.getAndroidAdbHost(),
      MIDSCENE_ANDROID_ADB_PORT: String(this.getAndroidAdbPort()),
    };
  }

  private buildHarmonyRuntimeEnv(resourceId: ResourceId): Record<string, string> {
    const deviceId = extractDeviceToken(resourceId);
    const env: Record<string, string> = {
      MIDSCENE_PLATFORM: "harmony",
      MIDSCENE_DEVICE_ID: deviceId,
      MIDSCENE_HARMONY_DEVICE_ID: deviceId,
    };
    const hdcPath = this.options.harmonyHdcPath?.trim();
    const hdcHost = this.options.harmonyHdcHost?.trim();
    if (hdcPath) env.MIDSCENE_HARMONY_HDC_PATH = hdcPath;
    if (hdcHost) env.MIDSCENE_HARMONY_HDC_HOST = hdcHost;
    if (Number.isFinite(this.options.harmonyHdcPort) && this.options.harmonyHdcPort! > 0) {
      env.MIDSCENE_HARMONY_HDC_PORT = String(Math.floor(this.options.harmonyHdcPort!));
    }
    return env;
  }

  private buildWrappedScript(task: TaskSpec, resourceId: ResourceId, runtimeEnv: Record<string, string>): string {
    if (task.requiredPlatform === PlatformType.IOS) {
      const wdaHost = pickNonEmptyString(runtimeEnv.MIDSCENE_IOS_WDA_HOST, this.getIosWdaHost());
      const wdaPortRaw = pickNonEmptyString(runtimeEnv.MIDSCENE_IOS_WDA_PORT, runtimeEnv.IOS_WDA_PORT);
      const wdaPort = toPositivePort(wdaPortRaw, "MIDSCENE_IOS_WDA_PORT");
      const deviceId = pickNonEmptyString(
        runtimeEnv.MIDSCENE_IOS_DEVICE_ID,
        runtimeEnv.MIDSCENE_DEVICE_ID,
        extractDeviceToken(resourceId),
      );
      return wrapIosTaskScript(task.script, {
        wdaHost: wdaHost ?? this.getIosWdaHost(),
        wdaPort,
        deviceId,
      });
    }

    if (task.requiredPlatform === PlatformType.ANDROID) {
      const adbHost = pickNonEmptyString(runtimeEnv.MIDSCENE_ANDROID_ADB_HOST, this.getAndroidAdbHost());
      const adbPortRaw = pickNonEmptyString(runtimeEnv.MIDSCENE_ANDROID_ADB_PORT, String(this.getAndroidAdbPort()));
      const serial = pickNonEmptyString(
        runtimeEnv.MIDSCENE_ANDROID_SERIAL,
        runtimeEnv.MIDSCENE_DEVICE_ID,
        extractDeviceToken(resourceId),
      );
      return wrapAndroidTaskScript(task.script, {
        adbHost: adbHost ?? this.getAndroidAdbHost(),
        adbPort: toPositivePort(adbPortRaw, "MIDSCENE_ANDROID_ADB_PORT"),
        serial,
      });
    }

    if (task.requiredPlatform === PlatformType.HARMONY) {
      const deviceId = pickNonEmptyString(
        runtimeEnv.MIDSCENE_HARMONY_DEVICE_ID,
        runtimeEnv.MIDSCENE_DEVICE_ID,
        extractDeviceToken(resourceId),
      );
      if (!deviceId) {
        throw new Error("MIDSCENE_HARMONY_DEVICE_ID is required");
      }
      const hdcHost = pickNonEmptyString(runtimeEnv.MIDSCENE_HARMONY_HDC_HOST);
      const hdcPortRaw = pickNonEmptyString(runtimeEnv.MIDSCENE_HARMONY_HDC_PORT);
      if ((hdcHost && !hdcPortRaw) || (!hdcHost && hdcPortRaw)) {
        throw new Error("MIDSCENE_HARMONY_HDC_HOST and MIDSCENE_HARMONY_HDC_PORT must be provided together");
      }
      return wrapHarmonyTaskScript(task.script, {
        deviceId,
        hdcPath: pickNonEmptyString(runtimeEnv.MIDSCENE_HARMONY_HDC_PATH),
        hdcTconnHost: hdcHost,
        hdcTconnPort: hdcPortRaw ? toPositivePort(hdcPortRaw, "MIDSCENE_HARMONY_HDC_PORT") : undefined,
      });
    }

    throw new Error(`unsupported platform for wrapping script: ${task.requiredPlatform}`);
  }

  private async waitForWdaHealthy(resourceId: string, wdaPort: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + this.options.iosWdaStartupTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.isWdaHealthy(resourceId, wdaPort)) return true;
      await sleep(1_000, signal);
    }
    return this.isWdaHealthy(resourceId, wdaPort);
  }

  private async prepareIosSession(resourceId: ResourceId, signal?: AbortSignal): Promise<PreparedMidsceneSession> {
    const cachedPort = this.resourceWdaPort.get(resourceId);
    if (cachedPort != null && (await this.isWdaHealthy(resourceId, cachedPort))) {
      return {
        platform: PlatformType.IOS,
        runtimeEnv: this.buildIosRuntimeEnv(resourceId, cachedPort),
        preparedAt: Date.now(),
      };
    }

    const mappedPort = await this.readMappedWdaPort(resourceId);
    if (mappedPort != null && (await this.isWdaHealthy(resourceId, mappedPort))) {
      this.resourceWdaPort.set(resourceId, mappedPort);
      console.info(`[MidsceneRuntimeReal] reuse WDA mapped port resourceId=${resourceId} wdaPort=${mappedPort}`);
      return {
        platform: PlatformType.IOS,
        runtimeEnv: this.buildIosRuntimeEnv(resourceId, mappedPort),
        preparedAt: Date.now(),
      };
    }

    if (mappedPort == null) {
      const existingPort = await this.findHealthyWdaPortInRange(resourceId, signal);
      if (existingPort != null) {
        this.resourceWdaPort.set(resourceId, existingPort);
        console.info(`[MidsceneRuntimeReal] reuse WDA scanned port resourceId=${resourceId} wdaPort=${existingPort}`);
        return {
          platform: PlatformType.IOS,
          runtimeEnv: this.buildIosRuntimeEnv(resourceId, existingPort),
          preparedAt: Date.now(),
        };
      }
    }

    const startTpl = this.options.iosWdaStartCommandTemplate?.trim();
    if (!startTpl) {
      throw new Error(
        `iOS resource ${resourceId} WDA is not healthy and IOS_WDA_START_COMMAND_TEMPLATE is not configured`,
      );
    }

    const wdaPort = mappedPort ?? (await this.resolveWdaStartupPortCandidate(resourceId));
    const command = renderTemplate(startTpl, resourceId, wdaPort);
    for (let attempt = 1; attempt <= this.options.iosWdaStartupRetry; attempt += 1) {
      console.info(
        `[MidsceneRuntimeReal] WDA bootstrap start resourceId=${resourceId} wdaPort=${wdaPort} attempt=${attempt}/${this.options.iosWdaStartupRetry}`,
      );
      const started = await this.commandRunner.run(command, this.options.iosWdaStartupTimeoutMs, signal);
      const alreadyDebugging = started.exitCode === WDA_ALREADY_DEBUGGING_EXIT_CODE;
      const shouldWaitForHealth = started.ok || alreadyDebugging;
      
      if (!shouldWaitForHealth) continue;
      if (!started.ok) {
        console.warn(
          `[MidsceneRuntimeReal] WDA bootstrap command failed resourceId=${resourceId} wdaPort=${wdaPort} attempt=${attempt} stdout=${started.stdout.slice(0, 200)} stderr=${started.stderr.slice(0, 400)}`,
        );
      }
      const ready = await this.waitForWdaHealthy(resourceId, wdaPort, signal);
      if (ready) {
        this.resourceWdaPort.set(resourceId, wdaPort);
        console.info(`[MidsceneRuntimeReal] WDA bootstrap ready resourceId=${resourceId} wdaPort=${wdaPort} attempt=${attempt}`);
        return {
          platform: PlatformType.IOS,
          runtimeEnv: this.buildIosRuntimeEnv(resourceId, wdaPort),
          preparedAt: Date.now(),
        };
      }
    }

    throw new Error(`WDA bootstrap failed for resource ${resourceId} wdaPort=${wdaPort}`);
  }

  private async prepareSession(
    task: TaskSpec,
    resourceId: ResourceId,
    signal?: AbortSignal,
  ): Promise<PreparedMidsceneSession> {
    if (task.requiredPlatform === PlatformType.IOS) {
      return this.prepareIosSession(resourceId, signal);
    }
    if (task.requiredPlatform === PlatformType.ANDROID) {
      return {
        platform: PlatformType.ANDROID,
        runtimeEnv: this.buildAndroidRuntimeEnv(resourceId),
        preparedAt: Date.now(),
      };
    }
    if (task.requiredPlatform === PlatformType.HARMONY) {
      return {
        platform: PlatformType.HARMONY,
        runtimeEnv: this.buildHarmonyRuntimeEnv(resourceId),
        preparedAt: Date.now(),
      };
    }
    throw new Error(`unsupported platform for midscene execution: ${task.requiredPlatform}`);
  }

  private async ensurePreparedSession(
    task: TaskSpec,
    resourceId: ResourceId,
    signal?: AbortSignal,
  ): Promise<PreparedMidsceneSession> {
    const cached = this.preparedSessions.get(resourceId);
    if (cached && cached.platform === task.requiredPlatform) {
      if (cached.platform !== PlatformType.IOS) return cached;
      const wdaPort = Number(cached.runtimeEnv.MIDSCENE_IOS_WDA_PORT);
      if (Number.isFinite(wdaPort) && wdaPort > 0 && (await this.isWdaHealthy(resourceId, wdaPort))) {
        return cached;
      }
    }
    const prepared = await this.prepareSession(task, resourceId, signal);
    this.preparedSessions.set(resourceId, prepared);
    return prepared;
  }

  async prepare(task: TaskSpec, resourceId: ResourceId, signal?: AbortSignal): Promise<void> {
    const prepared = await this.prepareSession(task, resourceId, signal);
    this.preparedSessions.set(resourceId, prepared);
  }

  async execute(
    task: TaskSpec,
    resourceId: ResourceId,
    signal?: AbortSignal,
    context?: MidsceneExecuteContext,
  ): Promise<MidsceneExecutionResult> {
    const prepared = await this.ensurePreparedSession(task, resourceId, signal);
    const runtimeEnv = {
      ...prepared.runtimeEnv,
      ...(context?.runtimeEnv ?? {}),
    };
    if (task.scriptKind === "airtest") {
      return this.airtestRuntime.execute(task, resourceId, signal, {
        ...context,
        runtimeEnv,
      });
    }
    runtimeEnv.MIDSCENE_RUN_DIR = resolveMidsceneRunDir(process.cwd(), { ...process.env, ...runtimeEnv });
    const wrappedScript = this.buildWrappedScript(task, resourceId, runtimeEnv);
    const baseDir = path.join(tmpdir(), "automation-agent-runs", String(Date.now()));
    await mkdir(baseDir, { recursive: true });
    const scriptFile = path.join(baseDir, "task-script.ts");
    await writeFile(scriptFile, wrappedScript, "utf8");

    const startedAt = Date.now();
    const command = renderMidsceneCommand(this.runCommandTemplate, resourceId, scriptFile);
    const reportStem = String(runtimeEnv.MIDSCENE_FLOW_REPORT_STEM ?? "").trim();
    const outputFormat: "single-html" | "html-and-external-assets" =
      runtimeEnv.MIDSCENE_OUTPUT_FORMAT === "html-and-external-assets" ? "html-and-external-assets" : "single-html";
    const reportRoot = getMidsceneReportRootDir(process.cwd(), { ...process.env, ...runtimeEnv });
    const reportPaths =
      reportStem.length > 0 ? resolveTaskReportFilePaths(reportRoot, reportStem, outputFormat) : null;
    let lastReportBytes = 0;
    const pollReport = async (): Promise<void> => {
      if (!context?.onReportProgress || !reportPaths) return;
      try {
        const st = await stat(reportPaths.reportHtmlPath);
        if (st.size <= lastReportBytes) return;
        lastReportBytes = st.size;
        const html = await readFile(reportPaths.reportHtmlPath, "utf8");
        context.onReportProgress({
          reportHtml: html,
          reportFormat: outputFormat,
          partial: true,
          reportName: reportPaths.reportName,
        });
      } catch {
        /* 报告尚未创建 */
      }
    };
    const htmlPollMs =
      reportPaths?.bundleDir && context?.onReportProgress ? 5000 : 2000;
    const reportPoll =
      reportPaths && context?.onReportProgress ? setInterval(() => void pollReport(), htmlPollMs) : null;

    let stopExecutionDumpWatch: (() => void) | undefined;
    if (reportPaths?.bundleDir && context?.onReportProgress) {
      await mkdir(reportPaths.bundleDir, { recursive: true });
      const allEnv: Record<string, string | undefined> = { ...process.env, ...runtimeEnv };
      stopExecutionDumpWatch = startExecutionDumpWatcher(
        reportPaths.bundleDir,
        async (payload) => {
          let reportHtml = "";
          try {
            reportHtml = await readFile(reportPaths.reportHtmlPath, "utf8");
          } catch {
            /* index.html 尚未写出时仍上传 dump / 资源，HTML 留空 */
          }
          context.onReportProgress!({
            reportHtml,
            reportFormat: outputFormat,
            partial: true,
            reportName: reportPaths.reportName,
            executionDumpJson: payload.executionDumpJson,
            executionDumpRevision: payload.executionDumpRevision,
            reportAssetFiles: payload.reportAssetFiles,
          });
        },
        {
          debounceMs: 450,
          imageCompression: {
            quality: Math.floor(numberFromEnv(allEnv, "MIDSCENE_REPORT_IMAGE_QUALITY", 100, 1, 100)),
            maxWidth: Math.floor(numberFromEnv(allEnv, "MIDSCENE_REPORT_IMAGE_MAX_WIDTH", 0, 0, 4096)) || undefined,
            overwriteFiles: truthyFromEnv(allEnv, "MIDSCENE_REPORT_IMAGE_OVERWRITE", true),
          },
        },
      ).stop;
    }

    const recordingReportDir = reportPaths?.bundleDir ?? (reportPaths ? path.dirname(reportPaths.reportHtmlPath) : null);
    const recorder = recordingReportDir
      ? await startVideoRecording(
          recordingReportDir,
          resolveVideoRecorderConfig(process.env, {
            platform: task.requiredPlatform,
            resourceId,
            taskId: context?.taskId,
            runtimeEnv,
          }),
        ).catch((err) => {
          console.warn(
            `[MidsceneRuntimeReal] video recorder start failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        })
      : null;
    const result = await this.commandRunner.run(command, this.options.runCommandTimeoutMs, signal, {
      env: runtimeEnv,
      onStdoutChunk: context?.onLogChunk
        ? (t) => {
            context.onLogChunk!(t, "stdout");
          }
        : undefined,
      onStderrChunk: context?.onLogChunk
        ? (t) => {
            context.onLogChunk!(t, "stderr");
          }
        : undefined,
    });
    const recordingResult = recorder ? await recorder.stop() : null;
    if (reportPoll) {
      clearInterval(reportPoll);
      await pollReport();
    }
    if (stopExecutionDumpWatch) {
      await new Promise<void>((resolveDelay) => {
        setTimeout(resolveDelay, 550);
      });
      stopExecutionDumpWatch();
    }
    const endedAt = Date.now();

    const logFile = path.join(baseDir, "runtime.log");
    const traceFile = path.join(baseDir, "runtime-trace.json");
    const screenshotFile = path.join(baseDir, "runtime-shot.png");

    await writeFile(
      logFile,
      [`command: ${command}`, `exitCode: ${result.exitCode}`, result.stdout, result.stderr].join("\n"),
      "utf8",
    );
    await writeFile(
      traceFile,
      JSON.stringify(
        {
          startedAt,
          endedAt,
          durationMs: endedAt - startedAt,
          exitCode: result.exitCode,
          ok: result.ok,
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(screenshotFile, "", "utf8");

    const artifacts: Array<{ type: ArtifactType; uri: string }> = [
      { type: ArtifactType.LOG, uri: `file://${logFile}` },
      { type: ArtifactType.TRACE, uri: `file://${traceFile}` },
      { type: ArtifactType.SCREENSHOT, uri: `file://${screenshotFile}` },
    ];
    if (recordingResult?.ok && recordingResult.outputPath) {
      artifacts.push({ type: ArtifactType.VIDEO, uri: `file://${recordingResult.outputPath}` });
    }
    let reportInfo: MidsceneTaskReportInfo | undefined;
    if (reportPaths) {
      try {
        const html = await readFile(reportPaths.reportHtmlPath, "utf8");
        let reportBundleZipPath: string | undefined;
        if (outputFormat === "html-and-external-assets" && reportPaths.bundleDir) {
          reportBundleZipPath = await zipDirectoryToFile(reportPaths.bundleDir, reportStem);
        }
        const ri: MidsceneTaskReportInfo = {
          reportHtmlPath: reportPaths.reportHtmlPath,
          reportName: reportPaths.reportName,
          reportFormat: outputFormat,
          reportBundleDir: reportPaths.bundleDir,
          reportBundleZipPath,
        };
        reportInfo = ri;
        context?.onReportProgress?.({
          reportHtml: html,
          reportFormat: outputFormat,
          partial: false,
          reportName: reportPaths.reportName,
          reportBundleZipUri: reportBundleZipPath ? `file://${reportBundleZipPath}` : undefined,
        });
        artifacts.push({ type: ArtifactType.REPORT, uri: `file://${reportPaths.reportHtmlPath}` });
        if (reportBundleZipPath) {
          artifacts.push({ type: ArtifactType.REPORT, uri: `file://${reportBundleZipPath}` });
        }
      } catch (err) {
        console.warn(
          `[MidsceneRuntimeReal] report artifact missing or unreadable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      ok: result.ok,
      message: result.ok ? "midscene real execution success" : result.stderr || "midscene execution failed",
      artifacts,
      reportInfo,
    };
  }
}
