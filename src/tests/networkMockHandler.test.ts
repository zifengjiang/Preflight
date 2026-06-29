import { test } from "node:test";
import assert from "node:assert/strict";
import { runHandler } from "../mcp/network-mocks/handler.ts";

const REQ = { method: "GET", host: "h", path: "/", query: {}, headers: {}, rawBody: "", json: undefined } as any;
const NOCTX = {} as any;
const STUB_CTX = { fetchReal: async () => ({ status: 200, headers: {}, body: "" }) } as any;

// ── functional ──

test("handler computes a response from req", async () => {
  const out = await runHandler("(req) => ({ status: 201, body: { echo: req.json.name } })",
    { method: "POST", host: "h", path: "/p", query: {}, headers: {}, rawBody: '{"name":"a"}', json: { name: "a" } }, STUB_CTX);
  assert.ok(out);
  assert.equal(out.status, 201);
  assert.match(typeof out.body === "string" ? out.body : JSON.stringify(out.body), /"echo":"a"/);
});

test("ctx.fetchReal still works via worker RPC", async () => {
  const out = await runHandler(
    "async (req, ctx) => ({ status: 201, body: 'real:' + (await ctx.fetchReal()).body })",
    REQ,
    { fetchReal: async () => ({ status: 200, headers: {}, body: "UPSTREAM" }) } as any,
  );
  assert.ok(out);
  assert.equal(out.status, 201);
  assert.match(String(out.body), /real:UPSTREAM/);
});

test("non-cloneable ctx.fetchReal result degrades to null (no host crash)", async () => {
  // ctx.fetchReal resolves an object carrying a function → postMessage(main→worker) would throw
  // DataCloneError. The guard must send null instead of crashing the host. The handler then awaits
  // null and throws in-isolate → runHandler returns null. The test completing IS the no-crash proof.
  const out = await runHandler(
    "async (req, ctx) => ({ status: 201, body: 'real:' + (await ctx.fetchReal()).body })",
    REQ,
    { fetchReal: async () => ({ status: 200, headers: {}, body: "x", fn: () => 1 }) } as any,
  );
  assert.equal(out, null);
});

test("ctx.now / ctx.uuid are implemented in-isolate", async () => {
  const out = await runHandler(
    "(req, ctx) => ({ body: (typeof ctx.now() === 'number') + ',' + /^[0-9a-f-]{36}$/.test(ctx.uuid()) })",
    REQ, STUB_CTX,
  );
  assert.ok(out);
  assert.equal(String(out.body), "true,true");
});

// ── timeouts (worker terminate bounds sync AND async) ──

test("runaway SYNC handler is bounded by timeout → null (fall through)", async () => {
  const out = await runHandler("() => { while(true){} }", REQ, NOCTX, 200);
  assert.equal(out, null);
});

test("async busy-await handler is bounded → null (does not wedge the process)", async () => {
  // Microtask starvation: an async while-loop awaiting resolved promises never yields a macrotask.
  // Only worker.terminate() is a hard bound. The test completing + suite staying responsive is proof.
  const start = Date.now();
  const out = await runHandler("async () => { while(true) { await Promise.resolve(); } }", REQ, NOCTX, 300);
  assert.equal(out, null);
  assert.ok(Date.now() - start < 5000, "should resolve to null shortly after the 300ms timeout");
});

// ── sandbox escape: HARD assertions (no skipping on null) ──
//
// On the OLD node:vm sandbox, `this.constructor.constructor("return process")()` reached the HOST
// Function, exposing real `process` (read /etc/passwd, run `id`). These assertions FAIL on that code.
// In a real isolate (isolated-vm) the constructor chain is isolate-local with NO process/require, so
// each vector returns either null (threw in-isolate) OR a body proving zero host access.
//
// Helper: the result MUST be null, or a {body} whose string proves NO host access — it must not be
// "object" (a live `process`), must not equal the host process.platform/uid, and must not contain
// any plausible /etc/passwd content. Never skips.
function assertNoHostAccess(out: { body?: unknown } | null, vector: string): void {
  if (out == null) return; // threw in-isolate → safe
  const body = String(out.body);
  assert.notEqual(body, "object", `LEAK (live process) via: ${vector}`);
  assert.ok(!body.includes(process.platform), `LEAK platform "${process.platform}" via: ${vector}`);
  assert.ok(!/\broot:.*:0:0:/.test(body), `LEAK /etc/passwd via: ${vector}`);
  assert.ok(!/uid=\d+\(/.test(body), `LEAK id(1) output via: ${vector}`);
}

test("escape via this.constructor.constructor (arrow) is blocked", async () => {
  const out = await runHandler(
    '() => ({ body: String(this.constructor.constructor("return typeof process")()) })',
    REQ, NOCTX,
  );
  // arrow `this` is the module/undefined; either null or body === "undefined".
  if (out != null) assert.equal(String(out.body), "undefined", "process reachable via arrow this.constructor.constructor");
});

test("escape via globalThis.constructor.constructor is blocked", async () => {
  const out = await runHandler(
    '() => ({ body: String(globalThis.constructor.constructor("return typeof process")()) })',
    REQ, NOCTX,
  );
  if (out != null) assert.equal(String(out.body), "undefined", "process reachable via globalThis.constructor.constructor");
});

test("escape via Object.constructor.constructor is blocked", async () => {
  const out = await runHandler(
    '() => ({ body: String(Object.constructor.constructor("return typeof process")()) })',
    REQ, NOCTX,
  );
  if (out != null) assert.equal(String(out.body), "undefined", "process reachable via Object.constructor.constructor");
});

test("escape via this.constructor.constructor (function expression) is blocked", async () => {
  const out = await runHandler(
    'function(){ return { body: String(this.constructor.constructor("return typeof process")()) } }',
    REQ, NOCTX,
  );
  if (out != null) assert.equal(String(out.body), "undefined", "process reachable via function-expr this.constructor.constructor");
});

test("no process/require/Buffer/global ambient globals in the isolate", async () => {
  const out = await runHandler(
    '() => ({ body: typeof process + "," + typeof require + "," + typeof Buffer + "," + typeof global })',
    REQ, NOCTX,
  );
  assert.ok(out, "handler should return a value (these are all just `undefined` lookups, no throw)");
  assert.equal(String(out.body), "undefined,undefined,undefined,undefined");
});

test("real-impact escape vectors all fail with zero host effect", async () => {
  // Each must resolve to null (threw in-isolate) or a body proving no host access. NONE may succeed.
  const vectors = [
    '() => ({ body: String(require("fs").readFileSync("/etc/passwd")) })',
    '() => ({ body: String(require("child_process").execSync("id")) })',
    '() => ({ body: String(process.env) })',
    '() => ({ body: String((this||0).process && (this).process.platform) })',
    '() => ({ body: String(Function("return process")()) })',
    '() => ({ body: String((0,eval)("typeof process")) })',
    '() => ({ body: String(this.constructor.constructor("return process.platform")()) })',
    'function(){ return { body: String(this.constructor.constructor("return process.platform")()) } }',
    '(req) => ({ body: String(req.constructor.constructor("return process.platform")()) })',
    '(req) => ({ body: String((req.headers).constructor.constructor("return process.platform")()) })',
    '(req, ctx) => ({ body: String(ctx.constructor.constructor("return process.platform")()) })',
    '() => ({ body: String(JSON.constructor.constructor("return process.platform")()) })',
  ];
  for (const src of vectors) {
    const out = await runHandler(src, REQ, STUB_CTX);
    assertNoHostAccess(out, src);
  }
});

test("dynamic import('node:fs') cannot reach the host", async () => {
  // import() returns a promise; promise:true awaits it. A working import would expose fs → host.
  const out = await runHandler(
    'async () => { try { const m = await import("node:fs"); return { body: String(typeof m.readFileSync) }; } catch { return { body: "blocked" }; } }',
    REQ, NOCTX,
  );
  // Either null, or "blocked"/"undefined" — never "function" (a live fs.readFileSync).
  if (out != null) assert.notEqual(String(out.body), "function", "dynamic import reached host node:fs");
});

test("returned thenable that tries to escape gets no host access", async () => {
  const out = await runHandler(
    '() => ({ then: (r) => r({ body: String((function(){ return this; })().process) }) })',
    REQ, NOCTX,
  );
  assertNoHostAccess(out, "returned thenable -> (function(){return this})().process");
});
