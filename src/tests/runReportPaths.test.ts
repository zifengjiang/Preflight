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

test("resolveRunReportDir prefers AGENT_HOME over runtimeRoot (where the agent actually writes)", () => {
  // The runtime launches the agent with AGENT_HOME=PREFLIGHT_HOME, and the agent resolves
  // midscene_run against AGENT_HOME — not runtimeRoot. reportDir must match that.
  const dir = resolveRunReportDir({ runtimeRoot: "/home/u/.preflight/runtime", env: { AGENT_HOME: "/home/u/.preflight" } });
  assert.equal(dir, "/home/u/.preflight/midscene_run/report");
});

test("resolveRunReportDir falls back to PREFLIGHT_HOME when AGENT_HOME is unset", () => {
  const dir = resolveRunReportDir({ runtimeRoot: "/home/u/.preflight/runtime", env: { PREFLIGHT_HOME: "/home/u/.preflight" } });
  assert.equal(dir, "/home/u/.preflight/midscene_run/report");
});
