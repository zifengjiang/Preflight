import vm from "node:vm";
import { Worker } from "node:worker_threads";

export interface HandlerReq {
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, unknown>;
  rawBody: string;
  json: unknown;
}

export interface HandlerResp {
  status?: number;
  headers?: Record<string, string>;
  body: string | unknown;
}

export interface HandlerCtx {
  fetchReal: () => Promise<{ status: number; headers: Record<string, unknown>; body: string }>;
}

/**
 * Compile the handler source to a vm.Script. Throws on syntax error — used by validate.ts to
 * syntax-check a rule's handler at parse time. This only PARSES (never executes), so it is safe
 * to run on the main thread.
 */
export function compileHandler(source: string): vm.Script {
  return new vm.Script(`(${source})`);
}

/**
 * Worker body (run with `eval: true`). It owns the actual handler execution so we can hard-kill a
 * runaway handler with `terminate()` from the main thread — bounding BOTH a synchronous `while(true)`
 * and an `async` microtask-starvation loop (which a setTimeout-based race on the main thread cannot
 * bound).
 *
 * Sandbox isolation (closes the constructor-chain RCE escape):
 *  - The handler runs in a fresh `vm.createContext({})` in STRICT mode. Strict mode makes a bare
 *    `this` inside a non-method handler `undefined`, killing the `this.constructor.constructor(...)`
 *    vector.
 *  - CRUCIALLY, every object the handler can reach is built INSIDE the context: `req` is JSON-parsed
 *    in-context and `ctx` (now/uuid/fetchReal) is constructed in-context. A plain object created in
 *    the worker's *main* realm (e.g. passed straight into createContext) carries that realm's
 *    prototype chain, whose `.constructor.constructor` is a Function with `process`/`require` on its
 *    global — i.e. a real escape. Building them in-context makes their prototype chain context-local
 *    (no `process`).
 *  - The only host-realm value we must expose is the fetchReal bridge function. We hand it in as a
 *    temporary global, capture it into a context-local closure, then DELETE the global so the handler
 *    can never name it (a directly-reachable host function is itself an escape via its constructor).
 *  - fetchReal's result crosses the bridge as a JSON STRING (a primitive) and is JSON-parsed
 *    in-context, so the object the handler sees is context-local too.
 *
 * The handler's return value is structured-cloned back via postMessage (plain status/headers/body
 * clone fine; a non-cloneable return throws in the worker → caught → null).
 */
const WORKER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const { source, reqJson, timeoutMs } = workerData;

// Host-side fetchReal bridge: posts an RPC and resolves with the upstream response as a JSON STRING.
let seq = 0; const pending = new Map();
function hostFetchReal() { const id = ++seq; return new Promise((res) => { pending.set(id, res); parentPort.postMessage({ t: "fetchReal", id }); }); }
parentPort.on("message", (m) => { if (m && m.t === "fetchRealResult") { const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m.dataJson); } } });

const sandbox = vm.createContext({});
// Temporarily expose the request payload (JSON string) + the host bridge fn as context globals.
sandbox.__reqJson = reqJson;
sandbox.__fetchRealJson = hostFetchReal;

// Step 1 — bootstrap INSIDE the context: build req/ctx context-locally, capture the host fn into a
// closure, delete the temporary globals, and stash req/ctx on __H for the handler step to read.
vm.runInContext(
  '"use strict";' +
  '(() => {' +
  '  const _hostFetch = __fetchRealJson;' +
  '  const req = JSON.parse(__reqJson);' +
  '  delete globalThis.__reqJson; delete globalThis.__fetchRealJson;' +
  '  const ctx = {' +
  '    now: () => Date.now(),' +
  '    uuid: () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; const v = c === "x" ? r : (r & 0x3 | 0x8); return v.toString(16); }),' +
  '    fetchReal: async () => { const s = await _hostFetch(); return s == null ? null : JSON.parse(s); },' +
  '  };' +
  '  globalThis.__H = { req, ctx };' +
  '})();',
  sandbox, { timeout: timeoutMs });

(async () => {
  try {
    // Step 2 — run the handler with the vm timeout (fast SYNC bound; main-thread terminate() is the
    // hard ASYNC backstop). __H.req/__H.ctx are context-local objects.
    const result = await vm.runInContext('"use strict";(' + source + ')(__H.req, __H.ctx)', sandbox, { timeout: timeoutMs });
    parentPort.postMessage({ t: "result", value: result == null ? null : result });
  } catch (e) { parentPort.postMessage({ t: "result", value: null }); }
})();
`;

/**
 * Run an inline mock handler in a worker_thread + clean, strict vm context.
 *
 * Security/timeout model:
 *  - The handler executes inside a worker, in an isolated vm context where every reachable object is
 *    built in-context, so `JSON.constructor.constructor("return process")()` and friends reach the
 *    context's own (process-less) Function → return undefined or throw, never host objects.
 *  - `vm.runInContext`'s `timeout` bounds the synchronous portion; the main-thread `terminate()`
 *    (fired by the backstop timer) is the HARD bound that also kills a runaway async handler that
 *    starves microtasks.
 *
 * On timeout, throw, or any error we return `null` so the caller falls through to the real response.
 *
 * NOTE: spawning a worker per call has ~10-40ms overhead. That is acceptable here because mocked
 * endpoints are low-volume; the safety guarantee (no RCE, no agent wedge) is worth the cost.
 */
export async function runHandler(
  source: string,
  req: HandlerReq,
  ctx: HandlerCtx,
  timeoutMs = 5000,
): Promise<HandlerResp | null> {
  // Serialize req to a JSON string so it is rebuilt context-locally in the worker (see WORKER_SRC).
  let reqJson: string;
  try { reqJson = JSON.stringify(req); } catch { return null; }

  return new Promise<HandlerResp | null>((resolve) => {
    const worker = new Worker(WORKER_SRC, { eval: true, workerData: { source, reqJson, timeoutMs } });
    let settled = false;
    // Single-settle guard: clear the timer, terminate the worker (so none leak between calls), and
    // resolve exactly once regardless of which event fires first.
    const finish = (v: HandlerResp | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(v);
    };
    // Hard-kill backstop: covers async microtask starvation that the vm `timeout` cannot bound.
    const timer = setTimeout(() => finish(null), timeoutMs + 500);

    worker.on("message", async (m: { t: string; id?: number; value?: unknown }) => {
      if (m.t === "fetchReal") {
        // Run the real upstream fetch on the main thread; send the result back as a JSON string.
        let dataJson: string | null = null;
        try { dataJson = JSON.stringify(await ctx.fetchReal()); } catch { /* upstream failed → handler sees null */ }
        if (!settled) worker.postMessage({ t: "fetchRealResult", id: m.id, dataJson });
      } else if (m.t === "result") {
        finish((m.value ?? null) as HandlerResp | null);
      }
    });
    worker.on("error", () => finish(null));
    worker.on("exit", () => finish(null));
  });
}
