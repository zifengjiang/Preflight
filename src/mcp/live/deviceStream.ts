import { spawn } from "node:child_process";
import http from "node:http";
import type { ServerResponse } from "node:http";
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
