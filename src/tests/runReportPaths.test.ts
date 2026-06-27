import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRunReportDir } from "../mcp/live/runReportPaths.ts";

test("resolveRunReportDir joins runtime root with midscene_run/report", () => {
  const dir = resolveRunReportDir({ runtimeRoot: "/tmp/app", env: {} });
  assert.equal(dir, "/tmp/app/midscene_run/report");
});

test("resolveRunReportDir honors MIDSCENE_RUN_DIR absolute override", () => {
  const dir = resolveRunReportDir({ runtimeRoot: "/tmp/app", env: { MIDSCENE_RUN_DIR: "/var/run/ms" } });
  assert.equal(dir, "/var/run/ms/report");
});

test("resolveRunReportDir resolves relative MIDSCENE_RUN_DIR against runtimeRoot", () => {
  const dir = resolveRunReportDir({ runtimeRoot: "/tmp/app", env: { MIDSCENE_RUN_DIR: "custom_run" } });
  assert.equal(dir, "/tmp/app/custom_run/report");
});
