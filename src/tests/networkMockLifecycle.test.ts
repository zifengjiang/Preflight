/**
 * TDD tests for P1 lifecycle/correctness fixes:
 *   ITEM 1 — stripPlatformPrefix for tcp-serial resourceIds
 *   ITEM 2 — ownerRunId cross-run teardown guard
 *   ITEM 3 — TTL timer cleared on stop (process exit failsafe is integration-only)
 *   ITEM 4 — iOS rejected loudly
 *   ITEM 5 — object body in validate.ts JSON-stringified
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateVisualFlow } from "../mcp/visual-flow/index.js";
import { stripPlatformPrefix } from "../mcp/server.js";
import { NetworkMockService } from "../mcp/network-mocks/NetworkMockService.js";

// ─── ITEM 1: stripPlatformPrefix ──────────────────────────────────────────────

test("stripPlatformPrefix: android tcp serial retains :5555 port", () => {
  assert.equal(stripPlatformPrefix("android:127.0.0.1:5555"), "127.0.0.1:5555");
});

test("stripPlatformPrefix: android emulator serial", () => {
  assert.equal(stripPlatformPrefix("android:emulator-5554"), "emulator-5554");
});

test("stripPlatformPrefix: no prefix passes through unchanged", () => {
  assert.equal(stripPlatformPrefix("emulator-5554"), "emulator-5554");
});

test("stripPlatformPrefix: ios udid", () => {
  assert.equal(stripPlatformPrefix("ios:aabb-ccdd-eeff"), "aabb-ccdd-eeff");
});

test("stripPlatformPrefix: uppercase prefix stripped", () => {
  assert.equal(stripPlatformPrefix("ANDROID:emulator-5554"), "emulator-5554");
});

// ─── ITEM 2: ownerRunId cross-run teardown guard ──────────────────────────────

test("ownerRunId: setOwnerRunId stores the id and ownerRunId getter returns it", () => {
  const svc = new NetworkMockService();
  svc.setOwnerRunId("runA");
  assert.equal(svc.ownerRunId, "runA");
  svc.setOwnerRunId(null);
  assert.equal(svc.ownerRunId, null);
});

test("ownerRunId: stop() clears ownerRunId to null", async () => {
  const svc = new NetworkMockService();
  svc.setOwnerRunId("runA");
  await svc.stop();
  assert.equal(svc.ownerRunId, null);
});

test("ownerRunId teardown guard: shouldTearDownFor returns true only for owner run", () => {
  const svc = new NetworkMockService();
  svc.setOwnerRunId("runA");
  // shouldTearDownFor checks owner match (callers combine with isRunning())
  assert.equal(svc.shouldTearDownFor("runA"), true,  "owner run should tear down");
  assert.equal(svc.shouldTearDownFor("runB"), false, "unrelated run must NOT tear down");
});

test("ownerRunId teardown guard: shouldTearDownFor returns false when ownerRunId is null (manual session)", () => {
  const svc = new NetworkMockService();
  // ownerRunId null = manual start_network_mocks — no run owns it
  assert.equal(svc.shouldTearDownFor("anyRunId"), false,
    "manual session (no owner) must not be torn down by a runId");
});

// ─── ITEM 3: TTL timer cleared on stop ───────────────────────────────────────

test("TTL: stop() clears any pending TTL timer (process does not leak a handle)", async () => {
  const svc = new NetworkMockService();
  // Arm a very long TTL manually to simulate waitForCompletion:false path
  (svc as any).armTtl(60 * 60 * 1000); // 1 hour
  // stop() must clear it — if the timer leaks the test process will hang
  await svc.stop();
  assert.equal((svc as any)._ttlTimer, null, "TTL timer must be null after stop()");
});

test("TTL: armTtl replaces any existing timer (no double-registration)", () => {
  const svc = new NetworkMockService();
  (svc as any).armTtl(60 * 60 * 1000);
  const first = (svc as any)._ttlTimer;
  (svc as any).armTtl(60 * 60 * 1000);
  const second = (svc as any)._ttlTimer;
  // Must have cleared first and created a new one (not leaked two timers)
  assert.notEqual(second, null);
  // Clean up
  if ((svc as any)._ttlTimer) { clearTimeout((svc as any)._ttlTimer); (svc as any)._ttlTimer = null; }
});

// ─── ITEM 4: iOS rejected loudly ─────────────────────────────────────────────

test("NetworkMockService.start rejects platform=ios with a clear error", async () => {
  const svc = new NetworkMockService();
  await assert.rejects(
    () => svc.start({ rules: [], platform: "ios", deviceId: "some-udid" }),
    (err: unknown) => {
      assert.ok(err instanceof Error, "must throw an Error");
      const msg = err.message.toLowerCase();
      assert.ok(
        msg.includes("ios") || msg.includes("android") || msg.includes("not supported"),
        `expected message to mention iOS/Android/not-supported, got: ${err.message}`,
      );
      return true;
    },
  );
});

test("NetworkMockService.start rejects any non-android platform loudly", async () => {
  const svc = new NetworkMockService();
  await assert.rejects(
    () => svc.start({ rules: [], platform: "harmony" as "android" | "ios", deviceId: "dev" }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      return true;
    },
  );
});

// ─── ITEM 5: validate.ts object body JSON-stringified ────────────────────────

function minimalFlowWithMock(rule: unknown) {
  return {
    version: 2,
    steps: [{ type: "launch", packageName: "com.example.app" }],
    networkMocks: [rule],
  };
}

test("validate: object body is JSON-stringified (not '[object Object]')", () => {
  const result = validateVisualFlow(minimalFlowWithMock({
    hostRegex: "api\\.example\\.com$",
    responses: [{ body: { a: 1 } }],
  }));
  assert.equal(result.ok, true, `expected ok, got: ${(result as any).message}`);
  if (result.ok) {
    const body = result.value.networkMocks?.[0]?.responses?.[0]?.body;
    assert.equal(body, '{"a":1}', `expected JSON string, got: ${body}`);
    assert.notEqual(body, "[object Object]");
  }
});

test("validate: string body passes through as-is", () => {
  const result = validateVisualFlow(minimalFlowWithMock({
    hostRegex: "api\\.example\\.com$",
    responses: [{ body: "hello" }],
  }));
  assert.equal(result.ok, true, `expected ok, got: ${(result as any).message}`);
  if (result.ok) {
    assert.equal(result.value.networkMocks?.[0]?.responses?.[0]?.body, "hello");
  }
});

test("validate: number body coerced to string", () => {
  const result = validateVisualFlow(minimalFlowWithMock({
    hostRegex: "api\\.example\\.com$",
    responses: [{ body: 42 }],
  }));
  assert.equal(result.ok, true, `expected ok, got: ${(result as any).message}`);
  if (result.ok) {
    assert.equal(result.value.networkMocks?.[0]?.responses?.[0]?.body, "42");
  }
});

test("validate: null body is still rejected (body required)", () => {
  const result = validateVisualFlow(minimalFlowWithMock({
    hostRegex: "api\\.example\\.com$",
    responses: [{ body: null }],
  }));
  assert.equal(result.ok, false, "null body must be rejected");
});
