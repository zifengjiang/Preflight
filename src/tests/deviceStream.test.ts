import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import {
  buildFfmpegMjpegCommand,
  buildScrcpyFfmpegArgs,
  buildScrcpyServerArgs,
  mjpegPart,
  proxyMjpeg,
} from "../mcp/live/deviceStream.ts";

test("mjpegPart wraps a jpeg buffer with multipart headers", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9]);
  const part = mjpegPart(jpeg, "FRAME");
  const text = part.toString("latin1");
  assert.match(text, /--FRAME/);
  assert.match(text, /Content-Type: image\/jpeg/);
  assert.match(text, /Content-Length: 5/);
});

test("mjpegPart includes jpeg bytes and ends with CRLF", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xaa, 0xbb, 0xd9]);
  const part = mjpegPart(jpeg, "FRAME");
  // The raw jpeg bytes must be present in the output
  const jpegOffset = part.indexOf(jpeg);
  assert.ok(jpegOffset > 0, "jpeg bytes should be present after headers");
  // Part must end with \r\n
  const tail = part.slice(-2).toString("latin1");
  assert.equal(tail, "\r\n");
});

test("ffmpeg command emits the same boundary the response header declares", () => {
  const cmd = buildFfmpegMjpegCommand("adb exec-out screenrecord --output-format=h264 -", "/x/ffmpeg");
  assert.match(cmd, /-boundary_tag PREFLIGHTFRAME\b/); // matches writeMjpegHeaders boundary
  assert.match(cmd, /while true; do .* done \|/); // relaunch loop present
  assert.match(cmd, /-f mpjpeg/);
});

test("buildScrcpyServerArgs runs the raw-h264 server with matching scid and all meta off", () => {
  const args = buildScrcpyServerArgs("3.3.4", "0a1b2c3d", { serial: "ABC" });
  // device serial is forwarded to adb
  assert.deepEqual(args.slice(0, 3), ["-s", "ABC", "shell"]);
  assert.ok(args.includes("com.genymobile.scrcpy.Server"));
  assert.ok(args.includes("3.3.4")); // version must match the binary or the server refuses to start
  assert.ok(args.includes("scid=0a1b2c3d"));
  assert.ok(args.includes("tunnel_forward=true"));
  // raw elementary stream: every metadata byte must be off
  for (const off of ["send_device_meta=false", "send_codec_meta=false", "send_frame_meta=false", "send_dummy_byte=false"]) {
    assert.ok(args.includes(off), `missing ${off}`);
  }
  assert.ok(args.some((a) => a.startsWith("CLASSPATH=")));
});

test("buildScrcpyServerArgs omits the serial flag when none is given", () => {
  const args = buildScrcpyServerArgs("3.3.4", "deadbeef");
  assert.equal(args[0], "shell");
  assert.ok(!args.includes("-s"));
});

test("buildScrcpyFfmpegArgs reads the tunneled tcp port with low-latency flags", () => {
  const args = buildScrcpyFfmpegArgs(41234);
  const joined = args.join(" ");
  assert.match(joined, /-fpsprobesize 0\b/); // the flag that unlocks incremental streaming
  assert.match(joined, /-f h264 -i tcp:\/\/127\.0\.0\.1:41234\b/);
  assert.match(joined, /-f mpjpeg/);
  assert.match(joined, /-boundary_tag PREFLIGHTFRAME\b/); // matches writeMjpegHeaders boundary
});

test("proxyMjpeg survives an upstream mid-stream drop (no uncaught throw)", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=ffmpeg" });
    res.write("--ffmpeg\r\n");
    res.socket?.destroy(); // simulate WDA hang-up mid-body
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;

  let ended = false;
  const fakeRes = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  }) as unknown as ServerResponse;
  (fakeRes as unknown as { writeHead: () => ServerResponse }).writeHead = () => fakeRes;
  const origEnd = fakeRes.end.bind(fakeRes);
  (fakeRes as unknown as { end: (...a: unknown[]) => unknown }).end = (...a: unknown[]) => {
    ended = true;
    return (origEnd as (...args: unknown[]) => unknown)(...a);
  };

  proxyMjpeg(fakeRes, `http://127.0.0.1:${port}/`);
  await new Promise((r) => setTimeout(r, 150));
  server.close();
  assert.ok(ended, "res should be ended after upstream drop (proves the error was handled, not thrown)");
});
