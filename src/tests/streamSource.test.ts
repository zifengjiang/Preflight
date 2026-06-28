import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStreamPlan } from "../mcp/live/streamSource.ts";

test("ios -> proxy WDA MJPEG url", () => {
  const plan = resolveStreamPlan({ platform: "IOS", wdaHost: "127.0.0.1", mjpegPort: 9100 });
  assert.deepEqual(plan, { kind: "mjpeg-proxy", url: "http://127.0.0.1:9100/" });
});

test("android -> scrcpy pipe carrying the device serial", () => {
  const plan = resolveStreamPlan({ platform: "ANDROID", serial: "ABC", adbHost: "127.0.0.1", adbPort: 5037 });
  assert.equal(plan.kind, "scrcpy-ffmpeg");
  if (plan.kind === "scrcpy-ffmpeg") {
    assert.equal(plan.adb, "adb");
    assert.equal(plan.serial, "ABC");
  }
});

test("harmony still uses the screenrecord pipe (deferred)", () => {
  const plan = resolveStreamPlan({ platform: "HARMONY", serial: "DEV1" });
  assert.equal(plan.kind, "screenrecord-ffmpeg");
  if (plan.kind === "screenrecord-ffmpeg") {
    assert.equal((plan.producer.match(/--output-format=h264/g) || []).length, 1);
  }
});
