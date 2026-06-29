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
 * syntax-check a rule's handler at parse time. This only PARSES (never executes), so it is safe to
 * run on the main thread. (This is the ONLY remaining use of node:vm; handler EXECUTION happens in a
 * real V8 isolate via isolated-vm — see WORKER_SRC.)
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
 * Security boundary — a real V8 isolate (isolated-vm), NOT node:vm:
 *  - node:vm is NOT a security boundary: an arrow/`globalThis` handler can reach the host realm's
 *    Function via `this.constructor.constructor("return process")()` and read/exec on the host
 *    (a real RCE). isolated-vm runs the handler in a separate V8 Isolate whose global has ONLY
 *    ECMAScript intrinsics (Object/JSON/Math/Date/Promise/...) — NO process/require/Buffer/console/
 *    global, and whose entire constructor chain is isolate-local (its `Function` has no `process`).
 *  - We inject NO host object or function as a raw value (a raw host fn would itself re-leak the host
 *    Function via its constructor). Values cross the isolate boundary ONLY via isolated-vm primitives:
 *      · req  → `new ExternalCopy(req).copyInto()` (a deep copy → plain in-isolate object).
 *      · fetchReal → `new ivm.Reference(workerFetchReal)`; the in-isolate `ctx.fetchReal()` calls
 *        `__fetchRealRef.apply(undefined, [], { result: { promise: true, copy: true } })`, which awaits
 *        the worker-realm promise and deep-copies the resolved {status,headers,body} INTO the isolate.
 *      · now/uuid are implemented IN-isolate (Date.now / Math.random) — no host call needed.
 *  - The handler runs via `context.eval("(" + source + ")(__req, __ctx)", { timeout, promise, copy })`:
 *    `promise:true` awaits an async handler's returned promise; `copy:true` copies the result out as a
 *    plain JS value; `timeout` bounds synchronous CPU. The main-thread `terminate()` (backstop timer)
 *    is the HARD bound that also kills a runaway async handler that starves microtasks.
 */
const WORKER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
const ivm = require("isolated-vm");
const { source, reqJson, timeoutMs } = workerData;

// Worker-realm fetchReal bridge: posts an RPC to the main thread and resolves with the upstream
// response OBJECT ({status,headers,body}) or null. isolated-vm copies this object into the isolate.
let seq = 0; const pending = new Map();
function workerFetchReal() { const id = ++seq; return new Promise((res) => { pending.set(id, res); parentPort.postMessage({ t: "fetchReal", id }); }); }
parentPort.on("message", (m) => { if (m && m.t === "fetchRealResult") { const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m.data == null ? null : m.data); } } });

const isolate = new ivm.Isolate({ memoryLimit: 128 });
const context = isolate.createContextSync();

(async () => {
  try {
    // Bridge req + the fetchReal Reference into the isolate. req is a deep COPY (plain in-isolate
    // object); the Reference is the only outward channel and is consumed solely by ctx.fetchReal.
    const req = JSON.parse(reqJson);
    context.global.setSync("__req", new ivm.ExternalCopy(req).copyInto());
    context.global.setSync("__fetchRealRef", new ivm.Reference(workerFetchReal));

    // Bootstrap __ctx IN-isolate: now/uuid are intrinsic-only; fetchReal awaits the worker-realm
    // promise via the Reference and gets the resolved object copied back in.
    context.evalSync(
      "globalThis.__ctx = {" +
      "  now: () => Date.now()," +
      "  uuid: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); })," +
      "  fetchReal: () => __fetchRealRef.apply(undefined, [], { result: { promise: true, copy: true } })," +
      "};"
    );

    // Run the handler: timeout bounds sync CPU; promise:true awaits an async return; copy:true copies
    // the result out as a plain JS value. main-thread terminate() is the hard async backstop.
    const result = await context.eval("(" + source + ")(__req, __ctx)", { timeout: timeoutMs, promise: true, copy: true });
    parentPort.postMessage({ t: "result", value: result == null ? null : result });
  } catch (e) {
    // Any throw (escape attempt, timeout, non-copyable result, isolate OOM) → null → caller falls through.
    parentPort.postMessage({ t: "result", value: null });
  } finally {
    try { isolate.dispose(); } catch {}
  }
})();
`;

/**
 * Run an inline mock handler in a worker_thread + a real V8 isolate (isolated-vm).
 *
 * Security/timeout model:
 *  - The handler executes inside a worker, in an isolated-vm Isolate whose global has only ECMAScript
 *    intrinsics and whose constructor chain is isolate-local — so `this.constructor.constructor(...)`,
 *    `globalThis.constructor.constructor(...)`, dynamic `import`, `Function("return process")()` etc.
 *    reach the isolate's own (process-less) realm → undefined/throw, NEVER the host (no RCE).
 *  - isolated-vm's `timeout` bounds the synchronous portion; the main-thread `terminate()` (fired by
 *    the backstop timer) is the HARD bound that also kills a runaway async handler that starves
 *    microtasks. The isolate is also disposed in the worker's finally.
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
  // Serialize req to a JSON string so it crosses to the worker, where it is parsed + ExternalCopy'd
  // into the isolate as a plain object.
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
    // Hard-kill backstop: covers async microtask starvation that the isolate `timeout` cannot bound.
    const timer = setTimeout(() => finish(null), timeoutMs + 500);

    worker.on("message", async (m: { t: string; id?: number; value?: unknown }) => {
      if (m.t === "fetchReal") {
        // Run the real upstream fetch on the main thread; send the result object back (structured
        // clone via postMessage). The worker resolves the Reference promise with it.
        let data: unknown = null;
        try { data = await ctx.fetchReal(); } catch { /* upstream failed → handler sees null */ }
        if (!settled) worker.postMessage({ t: "fetchRealResult", id: m.id, data });
      } else if (m.t === "result") {
        finish((m.value ?? null) as HandlerResp | null);
      }
    });
    worker.on("error", () => finish(null));
    worker.on("exit", () => finish(null));
  });
}
