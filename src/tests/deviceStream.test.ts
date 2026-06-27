import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { buildFfmpegMjpegCommand, mjpegPart, proxyMjpeg } from "../mcp/live/deviceStream.ts";

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
