import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateVisualFlow } from "../mcp/visual-flow/index.js";
import { NetworkMockServer } from "../mcp/network-mocks/NetworkMockServer.ts";

// ─── FIX A: ReDoS rejection via assertSafeRegexSource ──────────────────────

function minimalFlow(rules: unknown[]) {
  // version=2, steps needs a valid step; launch requires packageName
  return {
    version: 2,
    steps: [{ type: "launch", packageName: "com.example.app" }],
    networkMocks: rules,
  };
}

test("ReDoS: catastrophic hostRegex is rejected at validate time", () => {
  const result = validateVisualFlow(minimalFlow([{ hostRegex: "^(a+)+$", responses: [{ body: "x" }] }]));
  assert.equal(result.ok, false, "catastrophic hostRegex must be rejected");
  assert.ok(
    result.message?.toLowerCase().includes("redos") ||
    result.message?.toLowerCase().includes("unsafe") ||
    result.message?.toLowerCase().includes("catastrophic"),
    `expected message to mention ReDoS/unsafe, got: ${result.message}`,
  );
});

test("ReDoS: catastrophic pathRegex is rejected at validate time", () => {
  // (a+)+ has exponential backtracking on non-matching input like "aaaaab"
  const result = validateVisualFlow(minimalFlow([{
    hostRegex: "api\\.example\\.com$",
    pathRegex: "(a+)+$",
    responses: [{ body: "x" }],
  }]));
  assert.equal(result.ok, false, "catastrophic pathRegex must be rejected");
  assert.ok(
    result.message?.toLowerCase().includes("redos") ||
    result.message?.toLowerCase().includes("unsafe") ||
    result.message?.toLowerCase().includes("catastrophic"),
    `expected message to mention ReDoS/unsafe, got: ${result.message}`,
  );
});

test("ReDoS: over-1000-char hostRegex is rejected", () => {
  const long = "a".repeat(1001);
  const result = validateVisualFlow(minimalFlow([{ hostRegex: long, responses: [{ body: "x" }] }]));
  assert.equal(result.ok, false, "over-1000-char hostRegex must be rejected");
  assert.ok(
    result.message?.toLowerCase().includes("long") ||
    result.message?.toLowerCase().includes("too long") ||
    result.message?.toLowerCase().includes("length"),
    `expected message to mention length, got: ${result.message}`,
  );
});

test("ReDoS: safe regexes pass validation", () => {
  const result = validateVisualFlow(minimalFlow([{
    hostRegex: "api\\.example\\.com$",
    pathRegex: "^/v1/foo",
    responses: [{ body: "ok" }],
  }]));
  assert.equal(result.ok, true, `safe regexes must pass, got: ${(result as any).message}`);
});

// ─── FIX B: CA private key written with 0o600 ───────────────────────────────

test("persisted CA key has mode 0o600 (no group/other bits)", async () => {
  // Use an isolated PREFLIGHT_HOME so this test does not conflict with ~/.preflight
  const isolatedHome = join(tmpdir(), `preflight-test-ca-${process.pid}`);
  const orig = process.env.PREFLIGHT_HOME;
  process.env.PREFLIGHT_HOME = isolatedHome;
  const server = new NetworkMockServer();
  try {
    // loadOrGenerateRootCA() runs synchronously inside start() before the listen promise.
    // The key file is therefore written before the returned promise resolves.
    const port = await server.start([], "127.0.0.1", 0);
    assert.ok(port > 0);

    const pemPath = server.getRootCaPemPath();
    const keyPath = pemPath.replace(/\.pem$/, ".key");
    const stat = statSync(keyPath);
    // mode & 0o077 must be 0 — no group or other read/write/exec bits
    const groupOtherBits = stat.mode & 0o077;
    assert.equal(
      groupOtherBits,
      0,
      `CA key must not be group/other readable; got mode 0o${(stat.mode & 0o777).toString(8)}`,
    );
  } finally {
    await server.stop();
    process.env.PREFLIGHT_HOME = orig;
  }
});
