import vm from "node:vm";
import { randomUUID } from "node:crypto";

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
 * syntax-check a rule's handler at parse time.
 */
export function compileHandler(source: string): vm.Script {
  return new vm.Script(`(${source})`);
}

/**
 * Compile the *invocation* form `(${source})(__req, __ctx)` to a vm.Script so it can be compiled
 * once per rule and reused across requests. Throws on syntax error.
 */
export function compileHandlerInvocation(source: string): vm.Script {
  return new vm.Script(`(${source})(__req, __ctx)`);
}

/**
 * Run an inline mock handler in a node:vm sandbox.
 *
 * The sandbox scope is ONLY `req`/`ctx` plus the ECMAScript intrinsics (JSON/Math/Date) and a
 * no-op console — no `process`/`require`/`Buffer`/`globalThis` leakage.
 *
 * Timeout handling: the handler is INVOKED inside the vm via `(${source})(req, ctx)` so the vm
 * `timeout` bounds the *synchronous* run (a `while(true)` throws → caught → null). For an `async`
 * handler the vm returns the promise synchronously; `Promise.race` then bounds its async resolution.
 * On timeout or any throw we return `null` so the caller falls through to the real response.
 */
export async function runHandler(
  source: string,
  req: HandlerReq,
  ctx: HandlerCtx,
  timeoutMs = 5000,
  precompiled?: vm.Script,
): Promise<HandlerResp | null> {
  try {
    const ctxObj = { now: () => Date.now(), uuid: () => randomUUID(), fetchReal: ctx.fetchReal };
    const sandbox: Record<string, unknown> = {
      JSON,
      Math,
      Date,
      console: { log() {} },
      __req: req,
      __ctx: ctxObj,
    };
    const script = precompiled ?? compileHandlerInvocation(source);
    // Invoking inside the vm means a synchronous while(true) is bounded by `timeout` here.
    const result = script.runInNewContext(sandbox, { timeout: timeoutMs });
    const resolved = await Promise.race([
      Promise.resolve(result),
      new Promise((_, rej) => setTimeout(() => rej(new Error("handler timeout")), timeoutMs)),
    ]);
    if (resolved == null) return null;
    return resolved as HandlerResp;
  } catch {
    return null; // fall through to real on any error/timeout
  }
}
