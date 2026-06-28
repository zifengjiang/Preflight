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
