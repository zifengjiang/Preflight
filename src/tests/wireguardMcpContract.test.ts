import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPreflightMcpServer } from "../mcp/server.js";
import { AgentRuntimeManager } from "../mcp/agentRuntime.js";
import { NetworkMockService, type NetworkMockServiceStartConfig } from "../mcp/network-mocks/NetworkMockService.js";
import { WireGuardMockServer } from "../mcp/network-mocks/WireGuardMockServer.js";
import type { NetworkMockRule } from "../mcp/visual-flow/types.js";

const staticRules: NetworkMockRule[] = [{
  hostRegex: "api\\.example\\.com$", pathPattern: "/v1", pathRegex: "^/v1/data$",
  method: "GET", queryParams: { page: "1" }, description: "static response",
  responses: [{ status: 201, body: '{"ok":true}', callIndex: 1, headers: { "X-Test": "yes" }, delay: 0 }],
}];

test("WireGuard MCP advertises and enforces its actual contract", async (t) => {
  const runtime = t.mock.method(AgentRuntimeManager.prototype, "ensureStarted", async () => ({}));
  const start = t.mock.method(NetworkMockService.prototype, "start", async (_config: NetworkMockServiceStartConfig) => ({ running: true, port: 12345, mitmEnabled: true, rules: [] }));
  const update = t.mock.method(NetworkMockService.prototype, "updateRules", (_rules: NetworkMockRule[]) => {});
  let running = false;
  t.mock.method(NetworkMockService.prototype, "isRunning", () => running);
  const server = createPreflightMcpServer();
  const client = new Client({ name: "contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    for (const name of ["start_recording", "stop_recording", "export_recorded_rules"]) {
      assert.match(tools.find((tool) => tool.name === name)!.description!, /Unsupported:.*WireGuard/);
      for (const active of [false, true]) {
        running = active;
        const result = await client.callTool({ name, arguments: {} });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.content), /recording is not supported by the WireGuard transport/);
        assert.doesNotMatch(JSON.stringify(result.content), /Recording started|"count":0|"rules":\[\]/);
      }
    }
    for (const name of ["start_network_mocks", "update_network_mock_rules"]) {
      const schema = tools.find((tool) => tool.name === name)!.inputSchema as any;
      // z.never() must be published as a forbidden property, not a string input.
      assert.deepEqual(schema.properties.rules.items.properties.handler, { not: {} });
      for (const handler of ["return { body: 'dynamic' };", "", null, 42]) {
        for (const responses of [undefined, staticRules[0].responses]) {
          const result = await client.callTool({ name, arguments: {
            platform: "ANDROID", resourceId: "android:emulator-5554",
            rules: [{ hostRegex: "api.example.com", handler, responses }],
          } });
          assert.equal(result.isError, true);
          assert.match(JSON.stringify(result.content), /handler/);
        }
      }
    }
    assert.equal(runtime.mock.callCount(), 0);
    assert.equal(start.mock.callCount(), 0);
    assert.equal(update.mock.callCount(), 0);

    const started = await client.callTool({ name: "start_network_mocks", arguments: {
      platform: "ANDROID", resourceId: "android:127.0.0.1:5555", rules: staticRules,
    } });
    assert.notEqual(started.isError, true);
    assert.deepEqual(start.mock.calls[0].arguments[0].rules, staticRules);
    assert.equal(start.mock.calls[0].arguments[0].deviceId, "127.0.0.1:5555");
    running = true;
    const updated = await client.callTool({ name: "update_network_mock_rules", arguments: { rules: staticRules } });
    assert.notEqual(updated.isError, true);
    assert.deepEqual(update.mock.calls[0].arguments[0], staticRules);
    const cleared = await client.callTool({ name: "update_network_mock_rules", arguments: { rules: [] } });
    assert.notEqual(cleared.isError, true);
    assert.deepEqual(update.mock.calls[1].arguments[0], []);
  } finally {
    await client.close();
    await server.close();
  }
});

test("WireGuard recording APIs reject start, stop and export with or without an active server", () => {
  const backend = new WireGuardMockServer();
  const service = new NetworkMockService();
  for (const activeServer of [null, backend]) {
    Object.assign(service, { activeServer });
    for (const target of [backend, service]) {
      assert.throws(() => target.setRecording(true), /recording is not supported.*WireGuard/);
      assert.throws(() => target.setRecording(false), /recording is not supported.*WireGuard/);
      assert.throws(() => target.exportRecordedRules(), /recording is not supported.*WireGuard/);
      assert.equal(target.isRecording(), false);
      assert.equal(target.getRecordedCount(), 0);
    }
  }
});

test("handler rejection preserves an existing WireGuard session and rules", async (t) => {
  const backend = new WireGuardMockServer();
  const service = new NetworkMockService();
  Object.assign(backend, { process: {}, port: 12345 });
  Object.assign(service, { activeServer: backend });
  service.setOwnerRunId("existing-run");
  const backendStop = t.mock.method(backend, "stop", async () => {});
  const serviceStop = t.mock.method(service, "stop", async () => ({}));
  backend.updateRules(staticRules);
  const before = backend.getStats();
  for (const handler of ["return {};", ""]) {
    const rules = [{ ...staticRules[0], handler }];
    await assert.rejects(backend.start(rules), /handler rules are not supported/);
    await assert.rejects(service.start({ platform: "android", deviceId: "unused", rules }), /handler rules are not supported/);
    assert.throws(() => backend.updateRules(rules), /handler rules are not supported/);
    assert.throws(() => service.updateRules(rules), /handler rules are not supported/);
    assert.deepEqual(backend.getStats(), before);
    assert.equal(service.ownerRunId, "existing-run");
  }
  assert.equal(backendStop.mock.callCount(), 0);
  assert.equal(serviceStop.mock.callCount(), 0);
});

test("WireGuard hot updates keep static responses executable and rejected handlers leave the addon intact", () => {
  const dir = mkdtempSync(join(tmpdir(), "wireguard-contract-"));
  const addonPath = join(dir, "network_mock.py");
  const statsPath = join(dir, "stats.json");
  const backend = new WireGuardMockServer();
  Object.assign(backend, { addonPath, statsPath });
  try {
    backend.updateRules(staticRules);
    const original = readFileSync(addonPath, "utf8");
    assert.throws(() => backend.updateRules([{ ...staticRules[0], handler: "" }]), /handler rules are not supported/);
    assert.equal(readFileSync(addonPath, "utf8"), original);
    // Execute the emitted addon with a minimal mitmproxy HTTP interface; no device or daemon required.
    const exercise = (expectedBody: string) => execFileSync("python3", ["-c", `
import runpy, sys, types
http = types.SimpleNamespace(Response=types.SimpleNamespace(make=lambda status, body, headers: (status, body, headers)))
sys.modules['mitmproxy'] = types.SimpleNamespace(http=http)
m = runpy.run_path(sys.argv[1])
def flow(host):
    return types.SimpleNamespace(request=types.SimpleNamespace(host=host, url='https://' + host + '/v1/data?page=1', path='/v1/data', method='GET'), server_conn=types.SimpleNamespace(sni=host), client_conn=types.SimpleNamespace(), response=None)
f = flow('api.example.com')
m['request'](f)
assert f.response == (201, sys.argv[2].encode(), {'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'X-Preflight-Mock': 'true', 'X-Test': 'yes'}), f.response
f = flow('other.example.com')
m['request'](f)
assert f.response is None
f = flow('api.example.com')
m['request'](f)
assert f.response is None, 'callIndex=1 must only match once'
`, addonPath, expectedBody], { encoding: "utf8" });
    exercise('{"ok":true}');
    backend.updateRules([{ ...staticRules[0], responses: [{ ...staticRules[0].responses![0], body: "updated" }] }]);
    exercise("updated");
    backend.updateRules([]);
    assert.deepEqual(backend.getStats().rules, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
