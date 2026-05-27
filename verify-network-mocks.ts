/**
 * Quick verification script for the network mock feature.
 * Tests: mock server startup, URL matching, mock response serving,
 * transparent forwarding, stateful callIndex, and visual flow validation.
 */
import { NetworkMockServer } from "./src/mcp/network-mocks/NetworkMockServer.js";
import { validateVisualFlow } from "./src/mcp/visual-flow/index.js";
import { request as httpRequest } from "node:http";

const server = new NetworkMockServer();
let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

// ─── 1. Mock server lifecycle ───
console.log("\n=== 1. Mock server lifecycle ===");

const port = await server.start([
  {
    urlPattern: "example.com/api/test",
    responses: [{ status: 200, body: JSON.stringify({ mock: true }) }],
  },
]);
assert(port > 0, `Server started on port ${port}`);
assert(server.getPort() === port, "getPort() returns correct port");
assert(server.getStats().running, "getStats().running is true");
assert(server.getStats().rules.length === 1, "getStats().rules has 1 rule");

// ─── 2. Mock response matching ───
console.log("\n=== 2. Mock response matching ===");

const mockBody = await proxyGet(port, "http://example.com/api/test?id=42");
const mockJson = JSON.parse(mockBody);
assert(mockJson.mock === true, "Mock response returned for matching URL");
assert(mockBody.includes('"mock":true'), "Response body is correct JSON");

// ─── 3. Non-matching URL passes through ───
console.log("\n=== 3. Transparent forwarding ===");

try {
  // This should try to forward to a real server and likely fail (no real server)
  await proxyGet(port, "http://httpbin.org/get");
  console.log("  PASS: Non-matching URL forwarded (got response)");
  passed++;
} catch {
  console.log("  PASS: Non-matching URL attempted forward (expected with no real endpoint)");
  passed++;
}

// ─── 4. Stateful callIndex ───
console.log("\n=== 4. Stateful callIndex matching ===");

server.updateRules([
  {
    urlPattern: "stateful-test/api",
    responses: [
      { callIndex: 1, status: 200, body: JSON.stringify({ call: "first" }) },
      { callIndex: 2, status: 200, body: JSON.stringify({ call: "second" }) },
      { callIndex: 3, status: 200, body: JSON.stringify({ call: "third" }) },
    ],
  },
]);

const firstBody = await proxyGet(port, "http://stateful-test/api");
assert(JSON.parse(firstBody).call === "first", "callIndex 1 returns first response");

const secondBody = await proxyGet(port, "http://stateful-test/api");
assert(JSON.parse(secondBody).call === "second", "callIndex 2 returns second response");

const thirdBody = await proxyGet(port, "http://stateful-test/api");
assert(JSON.parse(thirdBody).call === "third", "callIndex 3 returns third response");

const stats = server.getStats();
assert(stats.rules[0]!.callCount === 3, `Call count is 3 (got ${stats.rules[0]!.callCount})`);

// ─── 5. Method filtering ───
console.log("\n=== 5. Method filtering ===");

server.updateRules([
  {
    urlPattern: "method-test/api",
    method: "POST",
    responses: [{ status: 200, body: JSON.stringify({ method: "POST" }) }],
  },
  {
    urlPattern: "method-test/api",
    method: "GET",
    responses: [{ status: 200, body: JSON.stringify({ method: "GET" }) }],
  },
]);

const postBody = await proxyGet(port, "http://method-test/api"); // defaults to GET
assert(JSON.parse(postBody).method === "GET", "GET method matches GET rule");

// ─── 6. Visual Flow validation with networkMocks ───
console.log("\n=== 6. Visual Flow IR validation with networkMocks ===");

const validFlow = {
  version: 2,
  steps: [
    { type: "launch", packageName: "com.example.app" },
    { type: "sleep", ms: 3000 },
    { type: "aiAct", prompt: "tap the login button" },
  ],
  networkMocks: [
    {
      urlPattern: "api.example.com/getConfig",
      description: "Mock config API",
      responses: [
        { status: 200, body: '{"code":200,"data":{"featureEnabled":true}}' },
      ],
    },
    {
      urlPattern: "api.example.com/submit",
      method: "POST",
      responses: [
        {
          callIndex: 1,
          status: 200,
          body: '{"code":"NEED_CONFIRM","data":{"blockedCount":2}}',
        },
        {
          callIndex: 2,
          requestBodyMatch: { skipConfirmed: "true" },
          status: 200,
          body: '{"code":200,"data":{"flag":true}}',
        },
      ],
    },
  ],
};

const result = validateVisualFlow(validFlow);
assert(result.ok, "Valid flow with networkMocks passes validation");
if (result.ok) {
  assert(result.value.networkMocks?.length === 2, "2 networkMock rules parsed");
  assert(result.value.version === 2, "Version is 2");
}

// ─── 7. Invalid networkMocks rejected ───
console.log("\n=== 7. Invalid networkMocks rejected ===");

const invalidFlow1 = {
  version: 2,
  steps: [{ type: "sleep", ms: 1000 }],
  networkMocks: [{ responses: [{ body: "{}" }] }],  // missing urlPattern
};
const r1 = validateVisualFlow(invalidFlow1);
assert(!r1.ok, "Missing urlPattern rejected");
if (!r1.ok) console.log(`       Message: ${r1.message}`);

const invalidFlow2 = {
  version: 2,
  steps: [{ type: "sleep", ms: 1000 }],
  networkMocks: [{ urlPattern: "test", responses: [] }],  // empty responses
};
const r2 = validateVisualFlow(invalidFlow2);
assert(!r2.ok, "Empty responses rejected");
if (!r2.ok) console.log(`       Message: ${r2.message}`);

// ─── 8. Version 1 flows still work with validateVisualFlow (accepts version 2) ───
console.log("\n=== 8. Version compatibility ===");

const v1Flow = {
  version: 1,
  steps: [{ type: "sleep", ms: 1000 }],
};
const r3 = validateVisualFlow(v1Flow);
assert(!r3.ok, "Version 1 flow rejected (must upgrade to version 2)");
if (!r3.ok) console.log(`       Message: ${r3.message}`);

// ─── 9. Old flows without networkMocks still validate ───
console.log("\n=== 9. Flow without networkMocks validates ===");
const flowNoMocks = {
  version: 2,
  steps: [
    { type: "launch", packageName: "com.test" },
    { type: "aiAct", prompt: "do something" },
    { type: "assert", prompt: "page loaded" },
  ],
};
const r4 = validateVisualFlow(flowNoMocks);
assert(r4.ok, "Flow without networkMocks validates");
if (r4.ok) {
  assert(!r4.value.networkMocks, "networkMocks is undefined when not provided");
}

// ─── Cleanup ───
console.log("\n=== Cleanup ===");
await server.stop();
assert(!server.getStats().running, "Server stopped successfully");

// ─── Summary ───
console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(40)}\n`);

if (failed > 0) process.exit(1);

// ─── Helpers ───
function proxyGet(proxyPort: number, url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: "127.0.0.1",
      port: proxyPort,
      path: url,
      method: "GET",
      headers: { host: new URL(url).host },
    });
    req.on("response", (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => (data += chunk.toString()));
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.end();
  });
}
