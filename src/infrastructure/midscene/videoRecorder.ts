import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { augmentPathForShellCommands } from "../system/CommandRunner.js";
import { PlatformType } from "../../shared-kernel/enums/index.js";

export type VideoInputSource =
  | { kind: "url"; url: string }
  | { kind: "command"; command: string; inputFormat: string }
  | { kind: "scrcpy-record"; serial: string }
  | { kind: "android-screenrecord-file"; adbPrefix: string; remotePath: string };

export interface VideoRecorderConfig {
  enabled: boolean;
  source?: VideoInputSource;
  fps: number;
  scaleWidth: number;
  crf: number;
  preset: string;
  playbackRate: number;
  outputName: string;
}

export interface VideoRecorderContext {
  platform: PlatformType;
  resourceId: string;
  taskId?: string;
  runtimeEnv: Record<string, string | undefined>;
}

export interface VideoRecordingHandle {
  outputPath: string;
  stop: () => Promise<{ ok: boolean; outputPath?: string; stderr: string }>;
}

function truthy(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function envString(env: Record<string, string | undefined>, key: string, fallback: string): string {
  const v = env[key]?.trim();
  return v ? v : fallback;
}

function envNumber(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(env[key]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function extractDeviceToken(resourceId: string): string {
  const idx = resourceId.indexOf(":");
  return idx >= 0 ? resourceId.slice(idx + 1) : resourceId;
}

function safeNamePart(raw: string): string {
  return raw
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function buildOutputName(ctx: VideoRecorderContext): string {
  const scope = safeNamePart(ctx.taskId || extractDeviceToken(ctx.resourceId) || "run");
  return `${ctx.platform.toLowerCase()}-${scope}-${Date.now()}.mp4`;
}

function buildRemoteAndroidRecordingPath(ctx: VideoRecorderContext): string {
  const scope = safeNamePart(ctx.taskId || extractDeviceToken(ctx.resourceId) || "run") || "run";
  return `/sdcard/preflight-${scope}-${Date.now()}.mp4`;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function positivePort(raw: string | undefined): number | undefined {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

function androidAdbCommandPrefix(ctx: VideoRecorderContext): string {
  const serial = envString(ctx.runtimeEnv, "MIDSCENE_ANDROID_SERIAL", extractDeviceToken(ctx.resourceId));
  const host = envString(ctx.runtimeEnv, "MIDSCENE_ANDROID_ADB_HOST", "127.0.0.1");
  const port = positivePort(ctx.runtimeEnv.MIDSCENE_ANDROID_ADB_PORT) ?? 5037;
  return `adb -H ${shQuote(host)} -P ${port} -s ${shQuote(serial)}`;
}

function harmonyHdcCommandPrefix(ctx: VideoRecorderContext): string {
  const hdc = envString(ctx.runtimeEnv, "MIDSCENE_HARMONY_HDC_PATH", "hdc");
  const host = ctx.runtimeEnv.MIDSCENE_HARMONY_HDC_HOST?.trim();
  const port = positivePort(ctx.runtimeEnv.MIDSCENE_HARMONY_HDC_PORT);
  const server = host && port ? ` -s ${shQuote(`${host}:${port}`)}` : "";
  const deviceId = envString(ctx.runtimeEnv, "MIDSCENE_HARMONY_DEVICE_ID", extractDeviceToken(ctx.resourceId));
  return `${shQuote(hdc)}${server} -t ${shQuote(deviceId)}`;
}

function resolveAutoSource(ctx: VideoRecorderContext): VideoInputSource | undefined {
  if (ctx.platform === PlatformType.IOS) {
    const host = envString(
      ctx.runtimeEnv,
      "MIDSCENE_IOS_WDA_HOST",
      "127.0.0.1",
    );
    const explicitMjpegPort =
      positivePort(ctx.runtimeEnv.MIDSCENE_IOS_WDA_MJPEG_PORT) ??
      positivePort(ctx.runtimeEnv.IOS_WDA_MJPEG_PORT);
    const wdaPort = positivePort(ctx.runtimeEnv.MIDSCENE_IOS_WDA_PORT) ?? positivePort(ctx.runtimeEnv.IOS_WDA_PORT);
    const mjpegPort = explicitMjpegPort ?? (wdaPort != null ? wdaPort + 1000 : undefined);
    if (!mjpegPort) return undefined;
    return { kind: "url", url: `http://${host}:${mjpegPort}/` };
  }

  if (ctx.platform === PlatformType.ANDROID) {
    return {
      kind: "scrcpy-record",
      serial: envString(ctx.runtimeEnv, "MIDSCENE_ANDROID_SERIAL", extractDeviceToken(ctx.resourceId)),
    };
  }

  if (ctx.platform === PlatformType.HARMONY) {
    return {
      kind: "command",
      command: `${harmonyHdcCommandPrefix(ctx)} shell screenrecord --output-format=h264 -`,
      inputFormat: "h264",
    };
  }

  return undefined;
}

export function resolveVideoRecorderConfig(
  env: Record<string, string | undefined>,
  context: VideoRecorderContext,
): VideoRecorderConfig {
  const runtimeEnv = { ...env, ...context.runtimeEnv };
  return {
    enabled: truthy(runtimeEnv.MIDSCENE_RECORD_VIDEO_ENABLED),
    source: resolveAutoSource({ ...context, runtimeEnv }),
    fps: Math.floor(envNumber(runtimeEnv, "MIDSCENE_RECORD_VIDEO_FPS", 30, 1, 120)),
    scaleWidth: Math.floor(envNumber(runtimeEnv, "MIDSCENE_RECORD_VIDEO_SCALE_WIDTH", 540, 120, 4096)),
    crf: Math.floor(envNumber(runtimeEnv, "MIDSCENE_RECORD_VIDEO_CRF", 32, 0, 51)),
    preset: envString(runtimeEnv, "MIDSCENE_RECORD_VIDEO_PRESET", "fast"),
    playbackRate: envNumber(runtimeEnv, "MIDSCENE_RECORD_VIDEO_PLAYBACK_RATE", 1, 0.1, 8),
    outputName: buildOutputName({ ...context, runtimeEnv }),
  };
}

function buildVideoFilters(config: VideoRecorderConfig): string {
  const filters = [`scale=${config.scaleWidth}:-2`];
  if (config.playbackRate !== 1) {
    filters.push(`setpts=${(1 / config.playbackRate).toFixed(6)}*PTS`);
  }
  return filters.join(",");
}

async function resolveFfmpegCommand(env: Record<string, string | undefined>): Promise<string> {
  const explicit = env.MIDSCENE_RECORD_VIDEO_FFMPEG_PATH?.trim() || env.FFMPEG_PATH?.trim();
  if (explicit) return explicit;
  try {
    const mod = (await import("@ffmpeg-installer/ffmpeg")) as { default?: { path?: string }; path?: string };
    const bundled = mod.default?.path ?? mod.path;
    if (bundled) return bundled;
  } catch {
    /* optional dependency; fall back to PATH */
  }
  return "ffmpeg";
}

function spawnEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: augmentPathForShellCommands(process.env.PATH),
  };
}

function buildFfmpegArgs(config: VideoRecorderConfig, outputPath: string, ffmpegCommand: string): string[] {
  if (!config.source) throw new Error("record video source is not available");
  const inputArgs =
    config.source.kind === "url"
      ? ["-i", config.source.url]
      : config.source.kind === "command"
        ? ["-f", config.source.inputFormat, "-i", "pipe:0"]
        : config.source.kind === "android-screenrecord-file"
          ? ["-i", config.source.remotePath]
          : (() => {
              throw new Error("scrcpy recording must be transcoded from its raw local file");
            })();
  // 对于实时流（URL / 管道），需要使用 fragmented MP4 确保中断时文件仍可播放。
  // frag_keyframe+empty_moov 让 moov atom 写在文件开头，播放器无需等待完整的
  // 文件尾部索引即可开始解码。
  const movflags =
    config.source?.kind === "url" || config.source?.kind === "command"
      ? ["-movflags", "frag_keyframe+empty_moov"]
      : [];
  return [
    ffmpegCommand,
    "-y",
    ...inputArgs,
    "-r",
    String(config.fps),
    "-vf",
    buildVideoFilters(config),
    ...movflags,
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    config.preset,
    "-crf",
    String(config.crf),
    outputPath,
  ];
}

export async function startVideoRecording(
  reportDir: string,
  config: VideoRecorderConfig,
): Promise<VideoRecordingHandle | null> {
  if (!config.enabled) return null;
  if (!config.source) {
    console.warn("[videoRecorder] enabled but no platform input source could be resolved");
    return null;
  }
  const recordingsDir = path.join(reportDir, "recordings");
  await mkdir(recordingsDir, { recursive: true });
  const outputPath = path.join(recordingsDir, config.outputName);
  const ffmpegCommand = await resolveFfmpegCommand(process.env);
  if (config.source.kind === "scrcpy-record") {
    return startScrcpyRecording(recordingsDir, outputPath, config, ffmpegCommand);
  }
  if (config.source.kind === "android-screenrecord-file") {
    return startAndroidFileRecording(recordingsDir, outputPath, config, ffmpegCommand);
  }
  const args = buildFfmpegArgs(config, outputPath, ffmpegCommand).slice(1);
  const sourceLabel = config.source.kind === "url" ? config.source.url : config.source.command;
  const child =
    config.source.kind === "url"
      ? spawn(ffmpegCommand, args, { stdio: ["ignore", "pipe", "pipe"], env: spawnEnv() })
      : spawn("sh", ["-lc", `${config.source.command} | ${shQuote(ffmpegCommand)} ${args.map(shQuote).join(" ")}`], {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: spawnEnv(),
        });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.stdout?.resume();
  child.on("error", (err) => {
    stderr += `\n${err.message}`;
  });
  console.info(
    `[videoRecorder] started source=${sourceLabel} fps=${config.fps} width=${config.scaleWidth} crf=${config.crf} output=${outputPath}`,
  );
  return {
    outputPath,
    stop: () => stopVideoRecording(child, outputPath, () => stderr),
  };
}

async function startScrcpyRecording(
  recordingsDir: string,
  outputPath: string,
  config: VideoRecorderConfig,
  ffmpegCommand: string,
): Promise<VideoRecordingHandle> {
  if (!config.source || config.source.kind !== "scrcpy-record") {
    throw new Error("scrcpy recording requires scrcpy-record source");
  }
  const rawPath = path.join(recordingsDir, `.raw-${path.basename(outputPath)}`);
  const args = ["-s", config.source.serial, "--no-window", "--record", rawPath];
  const child = spawn("scrcpy", args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: spawnEnv(),
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.stdout?.resume();
  child.on("error", (err) => {
    stderr += `\n${err.message}`;
  });
  console.info(
    `[videoRecorder] started source=scrcpy ${args.map(shQuote).join(" ")} fps=${config.fps} width=${config.scaleWidth} crf=${config.crf} output=${outputPath}`,
  );
  return {
    outputPath,
    stop: async () => {
      const stoppedStderr = await stopChildProcess(child, () => stderr);
      stderr = `${stderr}\n${stoppedStderr}`;
      const args = buildFfmpegArgs({ ...config, source: { kind: "url", url: pathToFileURL(rawPath).toString() } }, outputPath, ffmpegCommand);
      const transcode = await runProcess(args[0]!, args.slice(1), 120_000);
      stderr = `${stderr}\n${transcode.stderr}`;
      await rm(rawPath, { force: true }).catch(() => {});
      return finishStoppedRecording(outputPath, stderr);
    },
  };
}

async function startAndroidFileRecording(
  recordingsDir: string,
  outputPath: string,
  config: VideoRecorderConfig,
  ffmpegCommand: string,
): Promise<VideoRecordingHandle> {
  if (!config.source || config.source.kind !== "android-screenrecord-file") {
    throw new Error("android file recording requires android-screenrecord-file source");
  }
  const rawPath = path.join(recordingsDir, `.raw-${path.basename(outputPath)}`);
  const source = config.source;
  const command = `${source.adbPrefix} shell rm -f ${shQuote(source.remotePath)}; exec ${source.adbPrefix} shell screenrecord ${shQuote(source.remotePath)}`;
  const child = spawn("sh", ["-lc", command], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: spawnEnv(),
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.stdout?.resume();
  child.on("error", (err) => {
    stderr += `\n${err.message}`;
  });
  console.info(
    `[videoRecorder] started source=${command} fps=${config.fps} width=${config.scaleWidth} crf=${config.crf} output=${outputPath}`,
  );
  return {
    outputPath,
    stop: async () => {
      const stoppedStderr = await stopChildProcess(child, () => stderr);
      stderr = `${stderr}\n${stoppedStderr}`;
      const pull = await runShell(`${source.adbPrefix} pull ${shQuote(source.remotePath)} ${shQuote(rawPath)}`, 30_000);
      stderr = `${stderr}\n${pull.stderr}`;
      if (!pull.ok) {
        await runShell(`${source.adbPrefix} shell rm -f ${shQuote(source.remotePath)}`, 10_000).catch(() => {});
        return finishStoppedRecording(outputPath, stderr);
      }
      const args = buildFfmpegArgs({ ...config, source: { kind: "url", url: pathToFileURL(rawPath).toString() } }, outputPath, ffmpegCommand);
      const transcode = await runProcess(args[0]!, args.slice(1), 120_000);
      stderr = `${stderr}\n${transcode.stderr}`;
      await runShell(`${source.adbPrefix} shell rm -f ${shQuote(source.remotePath)}`, 10_000).catch(() => {});
      await rm(rawPath, { force: true }).catch(() => {});
      return finishStoppedRecording(outputPath, stderr);
    },
  };
}

async function stopVideoRecording(
  child: ChildProcess,
  outputPath: string,
  getStderr: () => string,
): Promise<{ ok: boolean; outputPath?: string; stderr: string }> {
  const stderr = await stopChildProcess(child, getStderr);
  return finishStoppedRecording(outputPath, stderr);
}

async function stopChildProcess(child: ChildProcess, getStderr: () => string): Promise<string> {
  if (child.exitCode != null || child.killed) {
    return getStderr();
  }
  if (child.pid != null && child.pid > 0) {
    try {
      process.kill(-child.pid, "SIGINT");
    } catch {
      child.kill("SIGINT");
    }
  }
  return new Promise<string>((resolve) => {
    const done = () => resolve(getStderr());
    const timer = setTimeout(() => {
      if (child.pid != null && child.pid > 0) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          if (child.exitCode == null && !child.killed) child.kill("SIGTERM");
        }
      }
      setTimeout(() => {
        if (child.exitCode == null && !child.killed) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }
        resolve(getStderr());
      }, 3_000);
    }, 8_000);
    child.once("close", () => {
      clearTimeout(timer);
      done();
    });
  });
}

function runShell(command: string, timeoutMs: number): Promise<{ ok: boolean; stderr: string }> {
  return runProcess("sh", ["-lc", command], timeoutMs);
}

function runProcess(command: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: spawnEnv() });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout?.resume();
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stderr: `${stderr}\n${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stderr });
    });
  });
}

async function finishStoppedRecording(
  outputPath: string,
  stderr: string,
): Promise<{ ok: boolean; outputPath?: string; stderr: string }> {
  try {
    const st = await stat(outputPath);
    if (st.isFile() && st.size > 0) {
      console.info(`[videoRecorder] stopped output=${outputPath} bytes=${st.size}`);
      return { ok: true, outputPath, stderr };
    }
  } catch {
    /* missing file */
  }
  console.warn(`[videoRecorder] stopped without output=${outputPath} stderr=${stderr.slice(-500)}`);
  await writeFile(`${outputPath}.stderr.log`, stderr || "video recording produced no output", "utf8").catch(() => {});
  return { ok: false, stderr };
}
