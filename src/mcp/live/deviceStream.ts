import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import http from "node:http";
import type { ServerResponse } from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { augmentPathForShellCommands } from "../../infrastructure/system/CommandRunner.js";

// ponytail: snapshot fallback (periodic device screenshots when stream can't start) is a deferred
// follow-up — it is device-dependent and cannot be unit-tested. The client already shows a graceful
// "SNAPSHOT" badge on <img> error (Task 8). Wire this in only after on-device verification.

const BOUNDARY = "PREFLIGHTFRAME";

export function mjpegPart(jpeg: Buffer, boundary = BOUNDARY): Buffer {
  const header = `--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, "latin1"), jpeg, Buffer.from("\r\n", "latin1")]);
}

async function resolveFfmpeg(): Promise<string> {
  try {
    const mod = (await import("@ffmpeg-installer/ffmpeg")) as { default?: { path?: string }; path?: string };
    return mod.default?.path ?? mod.path ?? "ffmpeg";
  } catch {
    return "ffmpeg";
  }
}

export function writeMjpegHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    "Cache-Control": "no-cache",
    Connection: "close",
  });
}

/** mjpeg-proxy (iOS): forward upstream MJPEG bytes verbatim. */
export function proxyMjpeg(res: ServerResponse, url: string): { stop: () => void } {
  const upstream = http.get(url, (up) => {
    // Propagate the upstream status + content-type before piping. `up.pipe(res)` forwards the body
    // only, so without this the browser receives multipart bytes with no
    // `Content-Type: multipart/x-mixed-replace` boundary and won't render them as a motion-JPEG
    // stream. WDA sends its own boundary in its content-type, which this forwards correctly.
    res.writeHead(up.statusCode ?? 200, {
      "Content-Type": up.headers["content-type"] ?? "multipart/x-mixed-replace",
      "Cache-Control": "no-cache",
      Connection: "close",
    });
    up.on("error", () => res.end()); // CRITICAL: handle mid-stream upstream drop (no uncaughtException)
    up.pipe(res);
  });
  upstream.on("error", () => res.end());
  res.on("close", () => upstream.destroy()); // IMPORTANT: stop the upstream read when the browser disconnects
  return { stop: () => upstream.destroy() };
}

/**
 * Build the shell pipeline that drives the Android/Harmony MJPEG stream.
 * - REFINEMENT A (spec §5.2): Android `screenrecord` has a ~3-minute cap; relaunch it in a loop so the
 *   MJPEG response stays alive across restarts. The sleep guard avoids a hot loop if the device drops.
 * - REFINEMENT B: single-quote the ffmpeg path (it can live under a path with spaces).
 * - `-boundary_tag ${boundary}`: ffmpeg's `mpjpeg` muxer defaults to boundary "ffmpeg"; force OUR
 *   boundary so the emitted stream matches the `Content-Type` header from `writeMjpegHeaders`.
 */
export function buildFfmpegMjpegCommand(producer: string, ffmpegPath: string, boundary = BOUNDARY): string {
  return `while true; do ${producer}; sleep 0.5; done | '${ffmpegPath}' -loglevel error -i - -f mpjpeg -boundary_tag ${boundary} -`;
}

/** screenrecord-ffmpeg (Android/Harmony): spawn (relaunching) producer | ffmpeg -f mpjpeg -. */
export async function spawnFfmpegMjpeg(res: ServerResponse, producer: string): Promise<{ stop: () => void }> {
  const cmd = buildFfmpegMjpegCommand(producer, await resolveFfmpeg());
  const child = spawn("sh", ["-lc", cmd], {
    stdio: ["ignore", "pipe", "ignore"],
    detached: true, // put the pipeline in its own process group so we can kill the whole tree
    env: { ...process.env, PATH: augmentPathForShellCommands(process.env.PATH) },
  });
  child.stdout?.pipe(res);
  const stop = () => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  };
  child.on("error", () => res.end());
  res.on("close", stop);
  return { stop };
}

// ---------------------------------------------------------------------------
// scrcpy-ffmpeg (Android): scrcpy-server streams raw h264 over an abstract
// socket; we tunnel it to a host TCP port with `adb forward` and let ffmpeg
// read the socket directly. This replaces the broken `screenrecord` pipe.
// ---------------------------------------------------------------------------

const REMOTE_JAR = "/data/local/tmp/preflight-scrcpy-server.jar";

/** Build the `adb` argv that launches scrcpy-server in raw-h264 mode on the device. */
export function buildScrcpyServerArgs(
  version: string,
  scid: string,
  opts: { serial?: string; remoteJar?: string } = {},
): string[] {
  const serial = opts.serial ? ["-s", opts.serial] : [];
  // `adb shell` joins these argv with spaces; the device sh treats `CLASSPATH=...` as an env prefix
  // to `app_process`. All metadata is turned off so the socket carries a pure h264 elementary stream.
  return [
    ...serial,
    "shell",
    `CLASSPATH=${opts.remoteJar ?? REMOTE_JAR}`,
    "app_process",
    "/",
    "com.genymobile.scrcpy.Server",
    version, // MUST match the installed scrcpy binary's version or the server refuses to start
    `scid=${scid}`,
    "tunnel_forward=true",
    "audio=false",
    "control=false",
    "cleanup=true",
    "video_codec=h264",
    "max_size=600",
    "max_fps=15",
    "send_device_meta=false",
    "send_codec_meta=false",
    "send_frame_meta=false",
    "send_dummy_byte=false",
  ];
}

/**
 * Build the ffmpeg argv that turns the tunneled h264 socket into MJPEG.
 * The low-latency flags are the hard-won part: `-f h264` buffers ALL output until input EOF unless
 * `find_stream_info` returns fast, so `-fpsprobesize 0` (skip fps probing of a variable trickle) plus
 * a SMALL `-probesize`/`-analyzeduration` (just enough for SPS+PPS+IDR) makes frames stream with ~1
 * frame of lag instead of never appearing.
 */
export function buildScrcpyFfmpegArgs(port: number, boundary = BOUNDARY): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-fpsprobesize",
    "0",
    "-probesize",
    "5000",
    "-analyzeduration",
    "50000",
    "-flags",
    "low_delay",
    "-f",
    "h264",
    "-i",
    `tcp://127.0.0.1:${port}`,
    "-f",
    "mpjpeg",
    "-boundary_tag",
    boundary,
    "-flush_packets",
    "1",
    "-",
  ];
}

async function resolveScrcpyServer(env: NodeJS.ProcessEnv): Promise<{ jar: string; version: string }> {
  const jar = process.env.PREFLIGHT_SCRCPY_SERVER || "/opt/homebrew/share/scrcpy/scrcpy-server";
  let version = process.env.PREFLIGHT_SCRCPY_VERSION || "";
  if (!version) {
    version = await new Promise<string>((resolve) => {
      const c = spawn("scrcpy", ["--version"], { stdio: ["ignore", "pipe", "ignore"], env });
      let out = "";
      c.stdout?.on("data", (d) => (out += d.toString()));
      c.on("error", () => resolve(""));
      c.on("exit", () => resolve(/scrcpy\s+(\d+\.\d+(?:\.\d+)?)/.exec(out)?.[1] ?? ""));
    });
  }
  return { jar, version: version || "3.3.4" };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Random 31-bit scid as 8 hex digits; the host uses the same string for the socket name and `scid=`. */
function randomScid(): string {
  return (crypto.randomBytes(4).readUInt32BE(0) & 0x7fffffff).toString(16).padStart(8, "0");
}

function runToCompletion(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: "ignore", env });
    c.on("error", reject);
    c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args[0]} exited ${code}`))));
  });
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** scrcpy-ffmpeg (Android): push jar -> adb forward -> spawn server -> ffmpeg(tcp) -> mpjpeg -> res. */
export async function spawnScrcpyMjpeg(
  res: ServerResponse,
  plan: { adb: string; serial?: string },
): Promise<{ stop: () => void }> {
  const env = { ...process.env, PATH: augmentPathForShellCommands(process.env.PATH) };
  const serialArgs = plan.serial ? ["-s", plan.serial] : [];
  const scid = randomScid();

  let server: ChildProcess | undefined;
  let ffmpeg: ChildProcess | undefined;
  let port = 0;
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    // Kill the whole process group of each detached child (ffmpeg + the local adb-shell client).
    try {
      if (ffmpeg?.pid) process.kill(-ffmpeg.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    try {
      if (server?.pid) process.kill(-server.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    // Free the host port mapping (best-effort, fire-and-forget). cleanup=true handles the device side.
    if (port) {
      try {
        spawn(plan.adb, [...serialArgs, "forward", "--remove", `tcp:${port}`], { stdio: "ignore", env }).unref();
      } catch {
        /* ignore */
      }
    }
    try {
      res.end();
    } catch {
      /* already ended */
    }
  };
  res.on("close", stop);

  try {
    const [{ jar, version }, ffmpegPath, allocated] = await Promise.all([
      resolveScrcpyServer(env),
      resolveFfmpeg(),
      freePort(),
    ]);
    port = allocated;
    // 1. push the server jar and 2. tunnel host tcp:port -> device abstract socket
    await runToCompletion(plan.adb, [...serialArgs, "push", jar, REMOTE_JAR], env);
    await runToCompletion(plan.adb, [...serialArgs, "forward", `tcp:${port}`, `localabstract:scrcpy_${scid}`], env);
    if (stopped) return { stop };
    // 3. launch the server (listens on the abstract socket)
    server = spawn(plan.adb, buildScrcpyServerArgs(version, scid, { serial: plan.serial }), {
      stdio: "ignore",
      detached: true,
      env,
    });
    server.on("error", stop);
    // 4. wait for the server to bind the socket before ffmpeg connects (emulator sw-encoder is slow)
    await delay(1500);
    if (stopped) return { stop };
    // 5. ffmpeg reads the tunneled socket -> mpjpeg -> response body
    ffmpeg = spawn(ffmpegPath, buildScrcpyFfmpegArgs(port), { stdio: ["ignore", "pipe", "ignore"], detached: true, env });
    ffmpeg.on("error", stop);
    ffmpeg.on("exit", stop);
    ffmpeg.stdout?.pipe(res);
  } catch {
    stop();
  }
  return { stop };
}
