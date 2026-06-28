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
