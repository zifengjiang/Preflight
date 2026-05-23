import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  MidsceneExecuteContext,
  MidsceneExecutionResult,
  MidsceneTaskReportInfo,
} from "../../domain/runtime/interfaces.js";
import type { TaskSpec } from "../../domain/task/TaskSpec.js";
import { ArtifactType, PlatformType } from "../../shared-kernel/enums/index.js";
import type { ResourceId } from "../../shared-kernel/ids/index.js";
import type { CommandRunner } from "../system/CommandRunner.js";
import { getMidsceneReportRootDir, resolveTaskReportFilePaths } from "../transport/midscenePaths.js";
import { zipDirectoryToFile } from "../midscene/zipReportDir.js";

const execFileAsync = promisify(execFile);

export interface AirtestRuntimeOptions {
  runCommandTimeoutMs: number;
  androidAdbHost?: string;
  androidAdbPort?: number;
  iosWdaHost?: string;
  harmonyHdcPath?: string;
}

export interface AirtestDeviceUriOptions {
  androidAdbHost?: string;
  androidAdbPort?: number;
  iosWdaHost?: string;
  iosWdaPort?: number;
  iosMjpegPort?: number;
  harmonyHdcPath?: string;
}

function extractDeviceToken(resourceId: string): string {
  const idx = resourceId.indexOf(":");
  return idx >= 0 ? resourceId.slice(idx + 1) : resourceId;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function requirePositivePort(value: string | number | undefined, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} is required`);
  return Math.floor(n);
}

export function buildAirtestDeviceUri(
  platform: PlatformType,
  resourceId: ResourceId,
  options: AirtestDeviceUriOptions,
): string {
  const token = extractDeviceToken(String(resourceId));
  if (platform === PlatformType.ANDROID) {
    return `Android://${options.androidAdbHost ?? "127.0.0.1"}:${options.androidAdbPort ?? 5037}/${token}`;
  }
  if (platform === PlatformType.IOS) {
    const port = requirePositivePort(options.iosWdaPort, "iosWdaPort");
    const mjpeg = requirePositivePort(options.iosMjpegPort ?? port + 1000, "iosMjpegPort");
    const host = options.iosWdaHost ?? "127.0.0.1";
    return `iOS:///http://${host}:${port}/?mjpeg_port=${mjpeg}&udid=${encodeURIComponent(token)}`;
  }
  if (platform === PlatformType.HARMONY) {
    const params = new URLSearchParams();
    if (options.harmonyHdcPath) params.set("hdc_path", options.harmonyHdcPath);
    const q = params.toString();
    return `Harmony:///${encodeURIComponent(token)}${q ? `?${q}` : ""}`;
  }
  throw new Error(`unsupported Airtest platform: ${platform}`);
}

function assertSafeZipEntries(entries: string[]): void {
  for (const entry of entries) {
    const clean = entry.replaceAll("\\", "/");
    if (!clean || clean.startsWith("/") || clean.includes("\0") || clean.split("/").includes("..")) {
      throw new Error(`unsafe airtest zip entry: ${entry}`);
    }
  }
}

async function unzipSafe(zipPath: string, targetDir: string): Promise<void> {
  const listing = await execFileAsync("unzip", ["-Z1", zipPath], { maxBuffer: 2 * 1024 * 1024 });
  assertSafeZipEntries(String(listing.stdout).split(/\r?\n/).filter(Boolean));
  await execFileAsync("unzip", ["-qq", "-o", zipPath, "-d", targetDir], { maxBuffer: 2 * 1024 * 1024 });
}

export class AirtestRuntime {
  constructor(
    private readonly commandRunner: CommandRunner,
    private readonly options: AirtestRuntimeOptions,
  ) {}

  async execute(
    task: TaskSpec,
    resourceId: ResourceId,
    signal?: AbortSignal,
    context?: MidsceneExecuteContext,
  ): Promise<MidsceneExecutionResult> {
    if (!task.airtest?.bundleBase64?.trim() || !task.airtest.entryDir?.trim()) {
      throw new Error("airtest bundle and entryDir are required");
    }
    const baseDir = await mkdtemp(path.join(tmpdir(), "airtest-run-"));
    const zipPath = path.join(baseDir, task.airtest.archiveName || "airtest.zip");
    const scriptRoot = path.join(baseDir, "script");
    await mkdir(scriptRoot, { recursive: true });
    await writeFile(zipPath, Buffer.from(task.airtest.bundleBase64, "base64"));
    await unzipSafe(zipPath, scriptRoot);

    const entryDir = path.resolve(scriptRoot, task.airtest.entryDir);
    if (!entryDir.startsWith(path.resolve(scriptRoot) + path.sep)) throw new Error("invalid airtest entryDir");
    const entryBase = path.basename(entryDir, ".air");
    await stat(path.join(entryDir, `${entryBase}.py`));

    const env = { ...process.env, ...(context?.runtimeEnv ?? {}) } as Record<string, string>;
    const reportStem = String(env.MIDSCENE_FLOW_REPORT_STEM ?? `airtest-${Date.now()}`).trim();
    const outputFormat: "single-html" | "html-and-external-assets" =
      env.MIDSCENE_OUTPUT_FORMAT === "html-and-external-assets" ? "html-and-external-assets" : "single-html";
    const reportRoot = getMidsceneReportRootDir(process.cwd(), { ...process.env, ...env });
    const reportPaths = resolveTaskReportFilePaths(reportRoot, reportStem, outputFormat);
    const reportDir = reportPaths.bundleDir ?? path.dirname(reportPaths.reportHtmlPath);
    const logDir = path.join(baseDir, "log");
    await mkdir(logDir, { recursive: true });
    await mkdir(reportDir, { recursive: true });

    const python = env.AIRTEST_PYTHON?.trim() || "python3";
    const pythonPath = env.AIRTEST_REPO_PATH?.trim();
    const childEnv = pythonPath
      ? { ...env, PYTHONPATH: [pythonPath, env.PYTHONPATH].filter(Boolean).join(path.delimiter) }
      : env;
    const deviceUri = buildAirtestDeviceUri(task.requiredPlatform, resourceId, {
      androidAdbHost: env.MIDSCENE_ANDROID_ADB_HOST ?? this.options.androidAdbHost,
      androidAdbPort: Number(env.MIDSCENE_ANDROID_ADB_PORT ?? this.options.androidAdbPort ?? 5037),
      iosWdaHost: env.MIDSCENE_IOS_WDA_HOST ?? this.options.iosWdaHost,
      iosWdaPort: Number(env.MIDSCENE_IOS_WDA_PORT ?? env.IOS_WDA_PORT),
      iosMjpegPort: Number(env.MIDSCENE_IOS_WDA_MJPEG_PORT ?? env.IOS_WDA_MJPEG_PORT),
      harmonyHdcPath: env.MIDSCENE_HARMONY_HDC_PATH ?? this.options.harmonyHdcPath,
    });

    const runCommand = [
      shellQuote(python),
      "-m airtest run",
      shellQuote(entryDir),
      "--device",
      shellQuote(deviceUri),
      "--log",
      shellQuote(logDir),
    ].join(" ");
    const startedAt = Date.now();
    const run = await this.commandRunner.run(runCommand, this.options.runCommandTimeoutMs, signal, {
      env: childEnv,
      onStdoutChunk: context?.onLogChunk ? (t) => context.onLogChunk!(t, "stdout") : undefined,
      onStderrChunk: context?.onLogChunk ? (t) => context.onLogChunk!(t, "stderr") : undefined,
    });

    const reportCommand = [
      shellQuote(python),
      "-m airtest report",
      shellQuote(entryDir),
      "--log_root",
      shellQuote(logDir),
      "--outfile",
      shellQuote(reportPaths.reportHtmlPath),
      ...(reportPaths.bundleDir ? ["--export", shellQuote(reportPaths.bundleDir)] : []),
    ].join(" ");
    const report = await this.commandRunner.run(reportCommand, this.options.runCommandTimeoutMs, signal, {
      env: childEnv,
      onStdoutChunk: context?.onLogChunk ? (t) => context.onLogChunk!(t, "stdout") : undefined,
      onStderrChunk: context?.onLogChunk ? (t) => context.onLogChunk!(t, "stderr") : undefined,
    });

    const endedAt = Date.now();
    const runtimeLog = path.join(baseDir, "runtime.log");
    const traceFile = path.join(baseDir, "runtime-trace.json");
    await writeFile(runtimeLog, [`command: ${runCommand}`, run.stdout, run.stderr, `report: ${reportCommand}`, report.stdout, report.stderr].join("\n"));
    await writeFile(traceFile, JSON.stringify({ startedAt, endedAt, durationMs: endedAt - startedAt, exitCode: run.exitCode, ok: run.ok && report.ok }, null, 2));

    const artifacts = [
      { type: ArtifactType.LOG, uri: `file://${runtimeLog}` },
      { type: ArtifactType.TRACE, uri: `file://${traceFile}` },
      { type: ArtifactType.REPORT, uri: `file://${reportPaths.reportHtmlPath}` },
    ];
    let reportInfo: MidsceneTaskReportInfo | undefined;
    if (run.ok && report.ok) {
      const html = await readFile(reportPaths.reportHtmlPath, "utf8");
      const reportBundleZipPath = reportPaths.bundleDir ? await zipDirectoryToFile(reportPaths.bundleDir, reportStem) : undefined;
      reportInfo = {
        reportHtmlPath: reportPaths.reportHtmlPath,
        reportName: reportPaths.reportName,
        reportFormat: outputFormat,
        reportBundleDir: reportPaths.bundleDir,
        reportBundleZipPath,
      };
      context?.onReportProgress?.({
        reportHtml: html,
        reportFormat: outputFormat,
        partial: false,
        reportName: reportPaths.reportName,
        reportBundleZipUri: reportBundleZipPath ? `file://${reportBundleZipPath}` : undefined,
      });
      if (reportBundleZipPath) artifacts.push({ type: ArtifactType.REPORT, uri: `file://${reportBundleZipPath}` });
    }

    return {
      ok: run.ok && report.ok,
      message: run.ok && report.ok ? "airtest execution success" : run.stderr || report.stderr || "airtest execution failed",
      artifacts,
      reportInfo,
    };
  }
}
