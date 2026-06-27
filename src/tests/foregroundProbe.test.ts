import { test } from "node:test";
import assert from "node:assert/strict";
import { probeForegroundBundleId } from "../mcp/live/foregroundProbe.ts";

test("android: parses bundleId from dumpsys via injected runner", async () => {
  const run = async () => "  mResumedActivity: ActivityRecord{abc u0 com.demo.app/.MainActivity t1}";
  const fg = await probeForegroundBundleId({ platform: "ANDROID", serial: "X" }, run);
  assert.equal(fg, "com.demo.app");
});

test("returns undefined when nothing matches (never throws)", async () => {
  const run = async () => { throw new Error("device offline"); };
  const fg = await probeForegroundBundleId({ platform: "ANDROID", serial: "X" }, run);
  assert.equal(fg, undefined);
});

test("android: omits -s when no serial (single device), still parses bundleId", async () => {
  const run = async (_cmd: string, args: string[]) => {
    assert.ok(!args.includes("-s"), "dangling -s flag present without serial");
    return "  mResumedActivity: ActivityRecord{abc u0 com.single.app/.Main t1}";
  };
  const fg = await probeForegroundBundleId({ platform: "ANDROID" }, run);
  assert.equal(fg, "com.single.app");
});
