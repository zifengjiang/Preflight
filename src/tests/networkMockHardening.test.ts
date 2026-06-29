import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateVisualFlow } from "../mcp/visual-flow/index.js";
import { NetworkMockServer } from "../mcp/network-mocks/NetworkMockServer.ts";
import type { ServerResponse } from "node:http";

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

// ─── ITEM 2: requestBodyMatch rejected by validation + not emitted on export ──

test("requestBodyMatch on a response is rejected by validateVisualFlow", () => {
  const result = validateVisualFlow(minimalFlow([{
    hostRegex: "api\\.example\\.com$",
    responses: [{ body: '{"ok":true}', requestBodyMatch: { key: "value" } }],
  }]));
  assert.equal(result.ok, false, "requestBodyMatch must be rejected");
  assert.ok(
    typeof result.message === "string" && result.message.toLowerCase().includes("requestbodymatch"),
    `expected message to mention requestBodyMatch, got: ${result.message}`,
  );
});

test("exportRecordedRules emits no requestBodyMatch even when a request body was recorded", () => {
  const s = new NetworkMockServer() as any;
  s.recorded = [
    { url: "https://api.example.com/submit", method: "POST", requestBody: '{"foo":"bar"}', responseBody: '{"ok":true}', status: 200 },
  ];
  const rules = s.exportRecordedRules();
  for (const rule of rules) {
    for (const resp of rule.responses ?? []) {
      assert.equal("requestBodyMatch" in resp, false, "exportRecordedRules must not emit requestBodyMatch");
    }
  }
});

// ─── ITEM 3: serveMock clamps bad status + JSON-stringifies object body ───────

function makeFakeRes(): { statusCode: number; headers: Record<string, string>; body: string } & ServerResponse {
  const r: any = { statusCode: 0, headers: {}, body: "" };
  r.writeHead = (s: number, h: Record<string, string>) => { r.statusCode = s; Object.assign(r.headers, h ?? {}); return r; };
  r.end = (b?: string) => { r.body = b ?? ""; return r; };
  return r;
}

test("serveMock: out-of-range status (99999) is clamped to 200 and does not throw", () => {
  const s = new NetworkMockServer() as any;
  const res = makeFakeRes();
  assert.doesNotThrow(() => s.serveMock({ status: 99999, body: { a: 1 } }, res));
  assert.equal(res.statusCode, 200, `status 99999 should clamp to 200, got ${res.statusCode}`);
});

test("serveMock: object body is JSON-stringified to {\"a\":1} with json content-type", () => {
  const s = new NetworkMockServer() as any;
  const res = makeFakeRes();
  s.serveMock({ status: 200, body: { a: 1 } }, res);
  assert.equal(res.body, '{"a":1}');
  const ct = res.headers["Content-Type"] ?? res.headers["content-type"];
  assert.ok(ct && ct.includes("application/json"), `expected json content-type, got ${ct}`);
});

// ─── ITEM 4: clearly catch-all hostRegex is rejected; normal suffix accepted ──

test("hostRegex '.*' (catch-all) is rejected with anchoring guidance", () => {
  const result = validateVisualFlow(minimalFlow([{ hostRegex: ".*", responses: [{ body: "x" }] }]));
  assert.equal(result.ok, false, "catch-all '.*' must be rejected");
  assert.ok(
    typeof result.message === "string" && (
      result.message.toLowerCase().includes("anchor") ||
      result.message.toLowerCase().includes("broad") ||
      result.message.toLowerCase().includes("catch-all")
    ),
    `expected anchoring guidance, got: ${result.message}`,
  );
});

test("hostRegex '' (empty) is rejected", () => {
  const result = validateVisualFlow(minimalFlow([{ hostRegex: "", responses: [{ body: "x" }] }]));
  assert.equal(result.ok, false, "empty hostRegex must be rejected");
});

test("hostRegex 'api\\\\.example\\\\.com$' (normal suffix) is accepted", () => {
  const result = validateVisualFlow(minimalFlow([{ hostRegex: "api\\.example\\.com$", responses: [{ body: "x" }] }]));
  assert.equal(result.ok, true, `safe suffix hostRegex must pass, got: ${(result as any).message}`);
});
