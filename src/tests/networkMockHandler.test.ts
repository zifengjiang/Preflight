import { test } from "node:test";
import assert from "node:assert/strict";
import { runHandler } from "../mcp/network-mocks/handler.ts";

test("handler computes a response from req", async () => {
  const out = await runHandler("(req) => ({ status: 201, body: { echo: req.json.name } })",
    { method: "POST", host: "h", path: "/p", query: {}, headers: {}, rawBody: '{"name":"a"}', json: { name: "a" } }, { fetchReal: async () => ({ status: 200, headers: {}, body: "" }) });
  assert.ok(out);
  assert.equal(out.status, 201);
  assert.match(typeof out.body === "string" ? out.body : JSON.stringify(out.body), /"echo":"a"/);
});

test("no process/require in scope", async () => {
  const out = await runHandler("() => ({ body: typeof process + ',' + typeof require })", { method:"GET",host:"h",path:"/",query:{},headers:{},rawBody:"",json:undefined } as any, {} as any);
  assert.ok(out);
  assert.match(String(out.body), /undefined,undefined/);
});

test("runaway handler is bounded by timeout → null (fall through)", async () => {
  const out = await runHandler("() => { while(true){} }", { method:"GET",host:"h",path:"/",query:{},headers:{},rawBody:"",json:undefined } as any, {} as any, 200);
  assert.equal(out, null);
});

const REQ = { method: "GET", host: "h", path: "/", query: {}, headers: {}, rawBody: "", json: undefined } as any;
const NOCTX = {} as any;

test("sandbox escape via JSON.constructor.constructor is blocked", async () => {
  // The classic escape: JSON.constructor.constructor reaches a Function whose global (on the OLD
  // code) had `process` → RCE. In the hardened context the reachable Function is process-less, so
  // this either throws in the worker (→ null) or sees `typeof process === "undefined"`.
  const out = await runHandler(
    "() => ({ body: String(typeof (JSON.constructor.constructor('return this.process')())) })",
    REQ, NOCTX,
  );
  if (out != null) assert.equal(String(out.body), "undefined");
});

test("sandbox escape via this.constructor.constructor is blocked", async () => {
  const out = await runHandler(
    "function(){ return { body: typeof this.constructor.constructor('return this.process')() } }",
    REQ, NOCTX,
  );
  if (out != null) assert.equal(String(out.body), "undefined");
});

test("sandbox cannot exfiltrate host process.platform (RCE proof)", async () => {
  // The strongest assertion: on the OLD code these constructor chains returned the host's real
  // process.platform (e.g. "darwin"). The fix must NEVER let a handler read it. Each vector must
  // resolve to null (threw in-worker) or, at worst, NOT equal the real platform.
  const vectors = [
    "() => ({ body: String(JSON.constructor.constructor('return process.platform')()) })",
    "function(){ return { body: String(this.constructor.constructor('return process.platform')()) } }",
    "(req) => ({ body: String(req.constructor.constructor('return process.platform')()) })",
    "(req) => ({ body: String((req.headers).constructor.constructor('return process.platform')()) })",
    "(req, ctx) => ({ body: String(ctx.constructor.constructor('return process.platform')()) })",
  ];
  for (const src of vectors) {
    const out = await runHandler(src, REQ, { fetchReal: async () => ({ status: 200, headers: {}, body: "" }) } as any);
    if (out != null) assert.notEqual(String(out.body), process.platform, `leaked via: ${src}`);
  }
});

test("async busy-await handler is bounded → null (does not wedge the process)", async () => {
  // Microtask starvation: an async while-loop awaiting resolved promises never yields a macrotask,
  // so a setTimeout-based race never fires. A worker terminate() is the only hard bound.
  // The test simply COMPLETING (and the suite staying responsive) is the proof.
  const start = Date.now();
  const out = await runHandler(
    "async () => { while(true) { await Promise.resolve(); } }",
    REQ, NOCTX, 300,
  );
  assert.equal(out, null);
  assert.ok(Date.now() - start < 5000, "should resolve to null shortly after the 300ms timeout");
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
