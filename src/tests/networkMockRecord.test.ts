import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { NetworkMockServer } from "../mcp/network-mocks/NetworkMockServer.ts";

/** Start a plain HTTP origin that writes 3 chunks and ends. */
function startOrigin(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const srv = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write("chunk-alpha-111111111111111111111111111111111111111111111111");
      res.write("chunk-beta--222222222222222222222222222222222222222222222222");
      res.end("chunk-gamma-333333333333333333333333333333333333333333333333");
    });
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      resolve({
        port: addr.port,
        close: () => new Promise((res2) => srv.close(() => res2())),
      });
    });
  });
}

/** Send a plain forward-proxy GET through the proxy to origin. Returns the full response body. */
function proxyGet(proxyPort: number, originPort: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const targetUrl = `http://127.0.0.1:${originPort}/data`;
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        // Absolute-URI format that a forward proxy expects
        path: targetUrl,
        headers: { Host: `127.0.0.1:${originPort}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString()));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("full body capture: exported recording contains full multi-chunk response body, not just last chunk", async () => {
  const origin = await startOrigin();
  const proxy = new NetworkMockServer();

  // Record-only rule: hostRegex matches 127.0.0.1, no responses → traffic forwarded + recorded
  await proxy.start([{ hostRegex: "127\\.0\\.0\\.1" }]);
  proxy.setRecording(true);

  try {
    const body = await proxyGet(proxy.getPort(), origin.port);

    // Sanity: the client received the full concatenated body
    const expected =
      "chunk-alpha-111111111111111111111111111111111111111111111111" +
      "chunk-beta--222222222222222222222222222222222222222222222222" +
      "chunk-gamma-333333333333333333333333333333333333333333333333";
    assert.equal(body, expected, "proxy should forward the full body to client");

    // The key assertion: exported rule body must be the full concatenation, not just last chunk
    const rules = proxy.exportRecordedRules();
    assert.equal(rules.length, 1, "should have recorded one request");
    const recorded = rules[0].responses?.[0];
    assert.ok(recorded, "should have a response in the exported rule");
    assert.equal(
      recorded.body,
      expected,
      "recorded response body should be full concatenation of all chunks",
    );
  } finally {
    await proxy.stop();
    await origin.close();
  }
});
