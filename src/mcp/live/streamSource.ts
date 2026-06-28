import type { RunState } from "../types.js";

export type StreamPlan =
  | { kind: "mjpeg-proxy"; url: string }
  | { kind: "scrcpy-ffmpeg"; adb: string; serial?: string } // android: scrcpy-server raw h264 over a tcp tunnel
  | { kind: "screenrecord-ffmpeg"; producer: string }; // producer = shell pipeline before ffmpeg

export function resolveStreamPlan(p: NonNullable<RunState["streamParams"]>): StreamPlan {
  if (p.platform === "IOS") {
    const host = p.wdaHost || "127.0.0.1";
    const port = p.mjpegPort ?? (p.wdaPort ? p.wdaPort + 1000 : 9200);
    return { kind: "mjpeg-proxy", url: `http://${host}:${port}/` };
  }
  if (p.platform === "HARMONY") {
    // Harmony has no scrcpy/hdc-stream equivalent; keep the screenrecord pipe (unverified, deferred).
    const hdc = p.hdcPath || "hdc";
    const dev = p.serial ? `-t ${p.serial} ` : "";
    return { kind: "screenrecord-ffmpeg", producer: `${hdc} ${dev}shell screenrecord --output-format=h264 -` };
  }
  // Android: `adb exec-out screenrecord` flushes h264 far too lazily for a live stream (ffmpeg emits
  // 0 frames until EOF). Use scrcpy-server instead — it streams a low-latency raw h264 elementary
  // stream over an abstract socket that we tunnel to the host with `adb forward`. See deviceStream.ts.
  return { kind: "scrcpy-ffmpeg", adb: "adb", serial: p.serial };
}
