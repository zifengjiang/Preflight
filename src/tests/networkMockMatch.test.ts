import { test } from "node:test";
import assert from "node:assert/strict";
import { NetworkMockServer } from "../mcp/network-mocks/NetworkMockServer.ts";

function srv(rules: any[]) { const s = new NetworkMockServer(); (s as any).rules = rules; return s as any; }

test("hostnameMatchesAnyRule uses hostRegex", () => {
  const s = srv([{ hostRegex: "api\\.example\\.com$", responses: [{ body: "x" }] }]);
  assert.equal(s.hostnameMatchesAnyRule("api.example.com"), true);
  assert.equal(s.hostnameMatchesAnyRule("cdn.other.com"), false);
});

test("findMatch gates on path", () => {
  const s = srv([{ hostRegex: "example\\.com$", pathRegex: "^/v1/foo", responses: [{ status: 200, body: "ok" }] }]);
  assert.ok(s.findMatch("GET", new URL("https://api.example.com/v1/foo?q=1")));
  assert.equal(s.findMatch("GET", new URL("https://api.example.com/v1/bar")), null);
});

test("record-only rule (no responses/handler) matches host but yields no mock", () => {
  const s = srv([{ hostRegex: "example\\.com$" }]);
  assert.equal(s.hostnameMatchesAnyRule("api.example.com"), true);
  assert.equal(s.findMatch("GET", new URL("https://api.example.com/anything")), null);
});

test("callCount is keyed per-rule: two rules sharing hostRegex but different path keep independent callIndex sequences", () => {
  const s = srv([
    { hostRegex: "ex\\.com$", pathRegex: "^/orders", responses: [{ callIndex: 1, body: "orders-1" }, { callIndex: 2, body: "orders-2" }] },
    { hostRegex: "ex\\.com$", pathRegex: "^/users", responses: [{ callIndex: 1, body: "users-1" }, { callIndex: 2, body: "users-2" }] },
  ]);
  // Fire /users first — must NOT consume the /orders counter
  assert.equal(s.findMatch("GET", new URL("https://api.ex.com/users")).body, "users-1");
  // /orders is still on its first call → callIndex 1
  assert.equal(s.findMatch("GET", new URL("https://api.ex.com/orders")).body, "orders-1");
  // Each advances independently
  assert.equal(s.findMatch("GET", new URL("https://api.ex.com/orders")).body, "orders-2");
  assert.equal(s.findMatch("GET", new URL("https://api.ex.com/users")).body, "users-2");
});

test("record-only rule before a mock rule on the same host falls through to the mock", () => {
  const s = srv([
    { hostRegex: "ex\\.com$" }, // record-only, no responses
    { hostRegex: "ex\\.com$", pathRegex: "^/v1/orders", responses: [{ status: 200, body: "ok" }] },
  ]);
  const match = s.findMatch("GET", new URL("https://api.ex.com/v1/orders"));
  assert.ok(match);
  assert.equal(match.body, "ok");
});
