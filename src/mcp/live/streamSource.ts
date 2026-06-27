import type { RunState } from "../types.js";

export type StreamPlan =
  | { kind: "mjpeg-proxy"; url: string }
  | { kind: "screenrecord-ffmpeg"; producer: string }; // producer = shell pipeline before ffmpeg

export function resolveStreamPlan(p: NonNullable<RunState["streamParams"]>): StreamPlan {
  if (p.platform === "IOS") {
    const host = p.wdaHost || "127.0.0.1";
    const port = p.mjpegPort ?? (p.wdaPort ? p.wdaPort + 1000 : 9200);
    return { kind: "mjpeg-proxy", url: `http://${host}:${port}/` };
  }
  if (p.platform === "HARMONY") {
    const hdc = p.hdcPath || "hdc";
    const dev = p.serial ? `-t ${p.serial} ` : "";
    return { kind: "screenrecord-ffmpeg", producer: `${hdc} ${dev}shell screenrecord --output-format=h264 -` };
  }
  const serial = p.serial ? `-s ${p.serial} ` : "";
  return { kind: "screenrecord-ffmpeg", producer: `adb ${serial}exec-out screenrecord --output-format=h264 -` };
}
