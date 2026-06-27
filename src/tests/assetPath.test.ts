import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSafeAssetPath } from "../mcp/live/assetPath.ts";

test("resolves a normal screenshot rel under the base dir", () => {
  const p = resolveSafeAssetPath("/tmp/report/stem", "screenshots/a.png");
  assert.equal(p, "/tmp/report/stem/screenshots/a.png");
});
test("rejects path traversal with ..", () => {
  assert.equal(resolveSafeAssetPath("/tmp/report/stem", "../../etc/passwd"), null);
});
test("rejects traversal via backslashes too", () => {
  assert.equal(resolveSafeAssetPath("/tmp/report/stem", "..\\..\\secret"), null);
});
test("rejects a sibling-prefix escape", () => {
  assert.equal(resolveSafeAssetPath("/tmp/report/stem", "../stem-evil/x"), null);
});
