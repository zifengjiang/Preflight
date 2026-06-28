# Preflight Network Mock — Auto on Android Emulator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make network mock fully automatic on the Android emulator — resurrect the `beta` MITM proxy, rework matching to hostRegex(decrypt-gate)+path(mock-gate), fix recording fidelity, add inline-JS dynamic handlers, and complete automatic CA trust (the piece beta missed).

**Architecture:** Build on `beta`. Resurrect the `src/mcp/network-mocks/*` module + IR + tools (the proven TLS/MITM/cert/tunnel plumbing). Then: (a) rework matching + IR; (b) fix the recording stream-tee; (c) add a `vm`-sandboxed handler; (d) replace beta's swallowed `tryInstallCaOnAndroid` with a robust `device-ca.ts` (`adb root` + user/system store + restorecon + idempotent); (e) keep beta's `run_flow` start/stop wiring. Spec: `docs/superpowers/specs/2026-06-28-preflight-network-mock-auto-design.md`.

**Tech Stack:** TypeScript (ESM, Node ≥ 20.11), `node:test` + `node:assert/strict` (`tsx --test`), `node:vm`, openssl + adb CLIs.

## KEY beta FINDING (drives several tasks)
`beta`'s `NetworkMockService.start` already calls `tryInstallCaOnAndroid`, which pushes the CA to `/data/misc/user/0/cacerts-added/<hash>.0` — but it never runs `adb root` and swallows all errors, so on a non-root adbd the `cp` is permission-denied and silently fails. `run_flow` already wires mock start/stop (beta `server.ts` lines ~208-311). So this plan is "resurrect + focused fixes/additions," not a rewrite.

**Conventions:** 2-space indent, double quotes, `.js` import suffixes, no default exports. `npm run check` to type-check, `npm test` to run tests. Commit after each task.

---

## Task 1: Spike — lock automatic CA trust on a rootable emulator

De-risks the one real unknown (user-store vs system-store) before `device-ca.ts`. Output: the exact, working adb sequence on the standardized image, recorded in the spec.

**Files:** Modify `docs/superpowers/specs/2026-06-28-preflight-network-mock-auto-design.md` (append "Resolved: CA install").

- [ ] **Step 1: Boot a rootable emulator**

REQUIRED SUB-SKILL: `android-emulator-setup` to create/boot an AVD from a `google_apis` (NOT `google_apis_playstore`) image, e.g. API 30.
Run: `adb devices` → expect `emulator-5554  device`. Then:
```bash
adb -s emulator-5554 root && adb -s emulator-5554 wait-for-device && echo ROOT-OK
```
Expected: `restarting adbd as root` then `ROOT-OK`. If it says "adbd cannot run as root in production builds", the image is wrong (Play image) — recreate with google_apis.

- [ ] **Step 2: Make a CA, compute the Android hash, push to the USER store**

```bash
cd /tmp && openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 3650 \
  -subj "/CN=Preflight Mock CA/O=Preflight" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
HASH=$(openssl x509 -inform PEM -subject_hash_old -noout -in ca.pem); echo "HASH=$HASH"
adb -s emulator-5554 push ca.pem /data/local/tmp/$HASH.0
adb -s emulator-5554 shell "mkdir -p /data/misc/user/0/cacerts-added && cp /data/local/tmp/$HASH.0 /data/misc/user/0/cacerts-added/$HASH.0 && chmod 644 /data/misc/user/0/cacerts-added/$HASH.0 && chown system:system /data/misc/user/0/cacerts-added/$HASH.0 && restorecon /data/misc/user/0/cacerts-added/$HASH.0 && echo USER-STORE-OK"
```
Expected: `USER-STORE-OK`. Then verify it is trusted (open Settings > Security > Encryption & credentials > User credentials, or check `settings`): the cert "Preflight Mock CA" appears under user CAs. Confirm a dev-controlled app that trusts user CAs accepts a MITM on its host (deferred to Task 8 if no app handy; for the spike, the cert appearing in the user store is enough).

- [ ] **Step 3: If user-store is not honored, test the SYSTEM store**

Only if Step 2's cert is not trusted by the target app. Relaunch the emulator with `-writable-system`, then:
```bash
adb -s emulator-5554 root && adb -s emulator-5554 remount
adb -s emulator-5554 push ca.pem /system/etc/security/cacerts/$HASH.0
adb -s emulator-5554 shell "chmod 644 /system/etc/security/cacerts/$HASH.0 && echo SYSTEM-STORE-OK"
```
(API ≥ 29 may need the conscrypt-APEX tmpfs overlay; record the working variant.)

- [ ] **Step 4: Record the decision**

Append a "Resolved: CA install" subsection to the spec: which store is the default for this image, the exact command sequence, and whether `-writable-system` is required. This feeds Task 6.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-06-28-preflight-network-mock-auto-design.md
git commit -m "docs(network-mock): lock CA auto-install sequence (spike)"
```

---

## Task 2: Resurrect the beta network-mocks module (compiling on this branch)

**Branch base & merge strategy:** `feat/network-mock` is cut from `main` AFTER the evidence work merges. The goal is "main's current code + beta's network-mock code on one branch." A literal `git merge beta` conflicts heavily because beta predates the live-viewer/evidence work (its `server.ts`/`types.ts`/`validate.ts` are old-base + mock vs main's new code, no mock). Achieve the same end state more cleanly by branching off `main` and bringing in only beta's mock code: restore the mock-only files wholesale, port the mock bits into the shared files by hand. Use `git merge beta` only if a merge-commit lineage is specifically wanted — then resolve shared-file conflicts by keeping main's version and re-adding the mock additions.

**Files:**
- Restore whole (mock-only, safe): `src/mcp/network-mocks/{NetworkMockServer,NetworkMockService,device-proxy,types,index}.ts`, `src/infrastructure/midscene/MidsceneRuntimeMock.ts`, `docs/network-mocks.md`.
- Port-by-hand (shared files main has changed — do NOT overwrite): `src/mcp/visual-flow/types.ts` (the `networkMocks` IR + `setMock`/`removeMock` step types), `src/mcp/visual-flow/validate.ts` (mock parsing), `src/mcp/server.ts` (mock tool registrations + run_flow start/stop wiring), `docs/visual-flow-ir-llm.md` (mock docs).

- [ ] **Step 1: Restore the mock-only files wholesale**

```bash
cd /Users/didi/Documents/preflight
git checkout beta -- \
  src/mcp/network-mocks \
  src/infrastructure/midscene/MidsceneRuntimeMock.ts \
  docs/network-mocks.md
git status --porcelain -- src/mcp/network-mocks
```
Expected: the 5 network-mocks files + MidsceneRuntimeMock + doc staged as new.

- [ ] **Step 2: Port the IR into `visual-flow/types.ts` (manual, additive)**

Inspect what beta had vs what main has:
```bash
git show beta:src/mcp/visual-flow/types.ts | sed -n '90,160p'
```
Add back to the CURRENT `types.ts` (do not clobber main): the `NetworkMockRule` / `NetworkMockResponse` interfaces, `networkMocks?: NetworkMockRule[]` on `VisualFlowDocument`, and the `setMock`/`removeMock` `VisualStep` variants. (The rule shape is reworked in Task 3 — for now bring beta's as-is so it compiles.)

- [ ] **Step 3: Port mock validation into `validate.ts` (manual, additive)**

From `git show beta:src/mcp/visual-flow/validate.ts`, re-add `parseSingleMockRule`, `parseNetworkMocks`, and the call site that attaches `networkMocks` to the validated document.

- [ ] **Step 4: Port server wiring into `server.ts` (manual, additive)**

From `git show beta:src/mcp/server.ts`, re-add: the `NetworkMockService` import + instance; the `run_flow` block that starts mocks when `networkMocks` present + tears down on terminal/cancel; and the tool registrations `start_network_mocks` / `stop_network_mocks` / `get_network_mock_status` / `update_network_mock_rules` / `get_root_ca_cert` / `start_recording` / `stop_recording` / `export_recorded_rules`. Keep main's existing tools intact.

- [ ] **Step 5: Compile + commit**

Run: `npm run check`
Expected: no type errors (fix import paths if any drift). Then:
```bash
git add -A -- src/mcp/network-mocks src/infrastructure/midscene/MidsceneRuntimeMock.ts docs/network-mocks.md src/mcp/visual-flow/types.ts src/mcp/visual-flow/validate.ts src/mcp/server.ts docs/visual-flow-ir-llm.md
git commit -m "feat(network-mock): resurrect beta mock module + IR + tools + run_flow wiring"
```

---

## Task 3: Rework matching — hostRegex (decrypt gate) + path (mock gate)

**Files:** Modify `src/mcp/visual-flow/types.ts`, `src/mcp/visual-flow/validate.ts`, `src/mcp/network-mocks/NetworkMockServer.ts`. Test: `src/tests/networkMockMatch.test.ts`.

- [ ] **Step 1: Update the IR types**

In `visual-flow/types.ts`, replace the rule's `urlPattern?/urlRegex?` with:
```typescript
export interface NetworkMockRule {
  /** REQUIRED — regex on the CONNECT host (SNI); gates MITM/decryption. */
  hostRegex: string;
  /** substring on the request path; OR pathRegex; if both omitted, all paths on the host. */
  pathPattern?: string;
  pathRegex?: string;
  method?: HTTPMethod;
  queryParams?: Record<string, string>;
  /** static responses (param-based selection); XOR with handler; neither = record-only. */
  responses?: NetworkMockResponse[];
  /** inline JS source: (req, ctx) => response | null (Task 5). */
  handler?: string;
  description?: string;
}
```
Update `removeMock` step to key on `hostRegex` instead of `urlPattern`.

- [ ] **Step 2: Write the failing matcher test**

`src/tests/networkMockMatch.test.ts`:
```typescript
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
```

- [ ] **Step 3: Run → fail**

Run: `npm test -- --test-name-pattern="hostnameMatchesAnyRule uses hostRegex|findMatch gates on path|record-only"`
Expected: FAIL (still using urlPattern).

- [ ] **Step 4: Rework the matchers in `NetworkMockServer.ts`**

Replace `hostnameMatchesAnyRule`:
```typescript
private hostnameMatchesAnyRule(hostname: string): boolean {
  return this.rules.some((rule) => { try { return new RegExp(rule.hostRegex).test(hostname); } catch { return false; } });
}
```
Replace the URL/path part of `findMatch` so it (a) requires `hostRegex` to match `url.hostname`, (b) gates on `pathPattern`/`pathRegex` (both optional → match all paths), keeping the existing method/queryParams/callIndex/requestBodyMatch logic and the per-rule callCount keying (key on `hostRegex` now). A rule with neither `responses` nor `handler` returns `null` from `findMatch` (record-only). Update `getRuleKey`/`callCounts`/`getStats` to key on `hostRegex`.

- [ ] **Step 5: Update validate `parseSingleMockRule`**

Require `hostRegex` (non-empty, valid regex); accept optional `pathPattern`/`pathRegex` (validate regex); allow at most one of `responses`/`handler`; `handler` syntax-checked in Task 5. Remove the `urlPattern || urlRegex` requirement.

- [ ] **Step 6: Run → pass + check + commit**

Run: `npm test -- --test-name-pattern="hostnameMatchesAnyRule uses hostRegex|findMatch gates on path|record-only"` (PASS), `npm run check`.
```bash
git add src/mcp/visual-flow/types.ts src/mcp/visual-flow/validate.ts src/mcp/network-mocks/NetworkMockServer.ts src/tests/networkMockMatch.test.ts
git commit -m "feat(network-mock): hostRegex decrypt-gate + path mock-gate matching"
```

---

## Task 4: Recording fidelity — capture full bodies via stream tee

**Files:** Modify `src/mcp/network-mocks/NetworkMockServer.ts`. Test: `src/tests/networkMockRecord.test.ts`.

- [ ] **Step 1: Write the failing test (multi-chunk capture)**

`src/tests/networkMockRecord.test.ts`: start the proxy with a record-only rule, point it at a tiny local origin that streams a body in 3 chunks via the proxy, then `exportRecordedRules()` and assert the exported response body equals the full concatenation (not just the last chunk). (Use `http.createServer` for the origin and a direct HTTP proxy request; HTTPS MITM is covered in Task 8 E2E.)

- [ ] **Step 2: Run → fail** (`npm test -- --test-name-pattern="full body"`, FAIL: truncated).

- [ ] **Step 3: Fix capture**

In `forwardRequest`/`forwardHttpsRequest`, when `this.recording`, accumulate the upstream response chunks (`pres.on("data", …)`) into a capped buffer alongside `pres.pipe(clientRes)`, and on `pres.on("end")` record the full body. Tee the request body similarly before `clientReq.pipe(pr)`. Remove the `res.end`/`res.writeHead` override hack in `recordForwarded`.

- [ ] **Step 4: Run → pass + commit**

```bash
git add src/mcp/network-mocks/NetworkMockServer.ts src/tests/networkMockRecord.test.ts
git commit -m "fix(network-mock): record full request/response bodies via stream tee"
```

---

## Task 5: Inline JS handler (vm sandbox + ctx.fetchReal)

**Files:** Create `src/mcp/network-mocks/handler.ts`. Modify `NetworkMockServer.ts` (invoke handler at the mock point), `validate.ts` (syntax-check + XOR). Test: `src/tests/networkMockHandler.test.ts`.

- [ ] **Step 1: Write the failing test**

`src/tests/networkMockHandler.test.ts`:
```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { runHandler } from "../mcp/network-mocks/handler.ts";

test("handler computes a response from req", async () => {
  const out = await runHandler("(req) => ({ status: 201, body: { echo: req.json.name } })",
    { method: "POST", host: "h", path: "/p", query: {}, headers: {}, rawBody: '{"name":"a"}', json: { name: "a" } }, { fetchReal: async () => ({ status: 200, headers: {}, body: "" }) });
  assert.equal(out.status, 201);
  assert.match(typeof out.body === "string" ? out.body : JSON.stringify(out.body), /"echo":"a"/);
});

test("no process/require in scope", async () => {
  const out = await runHandler("() => ({ body: typeof process + ',' + typeof require })", { method:"GET",host:"h",path:"/",query:{},headers:{},rawBody:"",json:undefined } as any, {} as any);
  assert.match(String(out.body), /undefined,undefined/);
});

test("runaway handler is bounded by timeout → null (fall through)", async () => {
  const out = await runHandler("() => { while(true){} }", { method:"GET",host:"h",path:"/",query:{},headers:{},rawBody:"",json:undefined } as any, {} as any, 200);
  assert.equal(out, null);
});
```

- [ ] **Step 2: Run → fail** (module missing).

- [ ] **Step 3: Implement `src/mcp/network-mocks/handler.ts`**

```typescript
import vm from "node:vm";
import { randomUUID } from "node:crypto";

export interface HandlerReq { method: string; host: string; path: string; query: Record<string, string>; headers: Record<string, unknown>; rawBody: string; json: unknown; }
export interface HandlerResp { status?: number; headers?: Record<string, string>; body: string | unknown; }
export interface HandlerCtx { fetchReal: () => Promise<{ status: number; headers: Record<string, unknown>; body: string }>; }

export function compileHandler(source: string): vm.Script {
  // throws on syntax error — used by validate.ts too
  return new vm.Script(`(${source})`);
}

export async function runHandler(source: string, req: HandlerReq, ctx: HandlerCtx, timeoutMs = 5000): Promise<HandlerResp | null> {
  try {
    const sandbox: Record<string, unknown> = { JSON, Math, Date, console: { log() {} } };
    const script = compileHandler(source);
    const fn = script.runInNewContext(sandbox, { timeout: timeoutMs }) as (r: HandlerReq, c: any) => unknown;
    const ctxObj = { now: () => Date.now(), uuid: () => randomUUID(), fetchReal: ctx.fetchReal };
    const result = fn(req, ctxObj);
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
```
Note: the vm `timeout` bounds synchronous run; the `Promise.race` bounds async. The sync infinite-loop test relies on the vm `timeout` throwing.

- [ ] **Step 4: Invoke the handler in `NetworkMockServer.ts`**

At the mock point (in `handleMitmRequest` and the HTTP `handleRequest`), when the matched rule has a `handler`: build `HandlerReq` (parse JSON body if `content-type` is JSON), provide `ctx.fetchReal()` (performs the existing forward to the real origin and buffers the response), call `runHandler`. If it returns a `HandlerResp` → serve it (object body → JSON). If `null` → forward to real (passthrough). Compile handlers once at `start()`/`updateRules()` and cache by rule.

- [ ] **Step 5: validate — syntax-check + XOR**

In `parseSingleMockRule`: if `handler` present, `compileHandler(handler)` in a try/catch → reject on syntax error; reject if both `handler` and `responses` set.

- [ ] **Step 6: Run → pass + check + commit**

```bash
git add src/mcp/network-mocks/handler.ts src/mcp/network-mocks/NetworkMockServer.ts src/mcp/visual-flow/validate.ts src/tests/networkMockHandler.test.ts
git commit -m "feat(network-mock): inline JS response handlers (vm sandbox + fetchReal)"
```

---

## Task 6: Robust automatic CA install (`device-ca.ts`)

Replaces beta's swallowed `tryInstallCaOnAndroid`.

**Files:** Create `src/mcp/network-mocks/device-ca.ts`. Modify `NetworkMockServer.ts` (persist CA to a stable path + expose it), `NetworkMockService.ts` (call `device-ca` instead of the inline best-effort). Test: `src/tests/deviceCa.test.ts`.

- [ ] **Step 1: Stable CA location**

In `NetworkMockServer.loadOrGenerateRootCA`, change `caDir` from `tmpdir()` to `join(process.env.PREFLIGHT_HOME?.trim() || join(homedir(), ".preflight"), "network-mock-ca")`. Expose `getRootCaPemPath(): string`.

- [ ] **Step 2: Write the failing test (command construction, injected runner)**

`src/tests/deviceCa.test.ts`: drive `installUserStoreCa({ serial, caPemPath, hash }, run)` with a fake `run` that records `(cmd,args)` and returns canned output; assert it (a) runs `adb -s <serial> root` then `wait-for-device`, (b) pushes to `/data/local/tmp/<hash>.0`, (c) runs the `cp + chmod 644 + restorecon` into `/data/misc/user/0/cacerts-added/<hash>.0`; and that `ensureCaInstalled` skips the push when an `ls` of the target returns the file (idempotency).

- [ ] **Step 2b: Run → fail** (module missing).

- [ ] **Step 3: Implement `device-ca.ts`**

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const pExecFile = promisify(execFile);
export type Runner = (cmd: string, args: string[]) => Promise<string>;
const defaultRunner: Runner = async (cmd, args) => (await pExecFile(cmd, args, { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 })).stdout.toString();

export async function computeAndroidHash(caPemPath: string, run: Runner = defaultRunner): Promise<string> {
  return (await run("openssl", ["x509", "-inform", "PEM", "-subject_hash_old", "-noout", "-in", caPemPath])).trim();
}

export async function adbRoot(serial: string, run: Runner = defaultRunner): Promise<void> {
  await run("adb", ["-s", serial, "root"]).catch(() => "");
  await run("adb", ["-s", serial, "wait-for-device"]);
}

export async function ensureCaInstalled(opts: { serial: string; caPemPath: string; mode?: "user" | "system" }, run: Runner = defaultRunner): Promise<{ installed: boolean; already: boolean; store: "user" | "system" }> {
  const hash = await computeAndroidHash(opts.caPemPath, run);
  await adbRoot(opts.serial, run);
  const store = opts.mode ?? "user"; // default per Task 1 spike
  if (store === "user") {
    const target = `/data/misc/user/0/cacerts-added/${hash}.0`;
    const ls = await run("adb", ["-s", opts.serial, "shell", `ls ${target} 2>/dev/null || true`]).catch(() => "");
    if (ls.includes(hash)) return { installed: true, already: true, store };
    await run("adb", ["-s", opts.serial, "push", opts.caPemPath, `/data/local/tmp/${hash}.0`]);
    await run("adb", ["-s", opts.serial, "shell",
      `mkdir -p /data/misc/user/0/cacerts-added && cp /data/local/tmp/${hash}.0 ${target} && chmod 644 ${target} && chown system:system ${target} && restorecon ${target}`]);
    const verify = await run("adb", ["-s", opts.serial, "shell", `ls ${target} 2>/dev/null || true`]).catch(() => "");
    return { installed: verify.includes(hash), already: false, store };
  }
  // system store (requires emulator booted with -writable-system)
  const sysTarget = `/system/etc/security/cacerts/${hash}.0`;
  await run("adb", ["-s", opts.serial, "remount"]);
  await run("adb", ["-s", opts.serial, "push", opts.caPemPath, sysTarget]);
  await run("adb", ["-s", opts.serial, "shell", `chmod 644 ${sysTarget}`]);
  const v = await run("adb", ["-s", opts.serial, "shell", `ls ${sysTarget} 2>/dev/null || true`]).catch(() => "");
  return { installed: v.includes(hash), already: false, store: "system" };
}
```
(Adjust the exact user/system sequence to the Task-1 spike result.)

- [ ] **Step 4: Wire into `NetworkMockService.start`**

Replace the inline `tryInstallCaOnAndroid(deviceId)` call (and delete that method) with `await ensureCaInstalled({ serial: config.deviceId, caPemPath: this.server.getRootCaPemPath() })`. Surface failure (do not swallow): if `installed` is false, throw so `run_flow` reports it (Task 7 turns it into a clear blocker).

- [ ] **Step 5: Run → pass + check + commit**

```bash
git add src/mcp/network-mocks/device-ca.ts src/mcp/network-mocks/NetworkMockServer.ts src/mcp/network-mocks/NetworkMockService.ts src/tests/deviceCa.test.ts
git commit -m "feat(network-mock): robust automatic CA install (adb root + user/system store, idempotent)"
```

---

## Task 7: run_flow lifecycle, record-only rules, doctor gate

**Files:** Modify `src/mcp/server.ts` (run_flow wiring already resurrected; verify + surface CA errors), `src/mcp/doctor.ts`. Test: `src/tests/doctorMockGate.test.ts`.

- [ ] **Step 1: Verify run_flow start/stop**

Confirm the resurrected wiring: `networkMocks` present + `resourceId` → `networkMockService.start(...)` before launch; stop on terminal status + cancel + finally. Ensure a thrown CA-install error from Task 6 aborts mock setup with a clear message (does not launch the flow under a half-configured mock).

- [ ] **Step 2: Record-only rules already work**

A rule with `hostRegex` and neither `responses` nor `handler` (Task 3) MITMs the host and `findMatch` returns null → forward + (when recording) capture. No new code; add an assertion in Task 8.

- [ ] **Step 3: doctor gate — failing test**

`src/tests/doctorMockGate.test.ts`: a pure helper `isRootableAdbOutput(rootStdout: string): boolean` returns false for "adbd cannot run as root in production builds" and true for "restarting adbd as root"/"already running as root". Test both.

- [ ] **Step 4: Implement + wire into doctor**

Add `isRootableAdbOutput` (in `device-ca.ts` or doctor). In `runDoctor`, when an Android emulator is present, run `adb -s <serial> root` and report a non-blocking note "network mock requires a rootable (non-Play) image" if it is not rootable.

- [ ] **Step 5: Run → pass + check + commit**

```bash
git add src/mcp/server.ts src/mcp/doctor.ts src/mcp/network-mocks/device-ca.ts src/tests/doctorMockGate.test.ts
git commit -m "feat(network-mock): surface CA errors in run_flow + doctor rootable-image gate"
```

---

## Task 8: Android-emulator end-to-end acceptance

Final gate — real stack on a rootable emulator. Not TDD; scripted checks + the agent observing.

- [ ] **Step 1: Boot rootable emulator** (`android-emulator-setup`; `adb root` succeeds).

- [ ] **Step 2: Record → export.** Author a record-only rule for a target host (`{ hostRegex: "<host>$" }`), `start_network_mocks`, `start_recording`, drive the app (or `adb shell am`/a curl-through-proxy to that host), `stop_recording`, `export_recorded_rules`. Verify the exported rule has a FULL response body (not truncated).

- [ ] **Step 3: Replay.** Feed an edited rule (static `responses`) back via `update_network_mock_rules`; confirm the app/curl gets the mock on the matched path, a non-matching path on the same host gets the REAL response, and a non-rule host is tunneled (real, never decrypted).

- [ ] **Step 4: Handler.** Add a rule with an inline `handler` that echoes a request field and injects `ctx.uuid()`; confirm the computed response; confirm a handler using `ctx.fetchReal()` transforms the real body.

- [ ] **Step 5: Cert auto.** Confirm all the above worked WITHOUT any manual cert step (the CA was auto-installed; the app trusted the MITM on the specified host). Confirm teardown removed the proxy (`settings get global http_proxy` → `:0`/null).

- [ ] **Step 6: run_flow.** A `visualFlow` with `networkMocks` runs end-to-end via `run_flow` (auto start + stop). Record any gaps as fixes against Tasks 3-7; re-run.

- [ ] **Step 7: Leave verification 留痕.** Run a representative `networkMocks` flow via `run_flow` → `save_report`; archive the resulting evidence folder (`evidence.html` + `assets/` + the inline verdict card), the `export_recorded_rules` JSON, and a short pass/fail log as the verification artifact attached to the merge-to-main PR. This reuses the evidence feature already on `main`, so the network-mock verification is itself captured as evidence. Required before merging `feat/network-mock` back to `main`.

---

## Self-Review (completed during authoring)

- **Spec coverage:** emulator-only auto cert (Tasks 1, 6), reuse beta (Task 2), hostRegex/path matching (Task 3), recording fidelity (Task 4), inline JS handler + fetchReal (Task 5), run_flow lifecycle + record-only + doctor gate (Task 7), E2E incl record→export→replay (Task 8). All spec sections map to a task.
- **Placeholder scan:** novel modules (`handler.ts`, `device-ca.ts`) have full code; resurrected code uses concrete `git checkout`/`git show` commands + named rework; spike (Task 1) and E2E (Task 8) have concrete commands. No TBD.
- **Type/name consistency:** `hostRegex`/`pathPattern`/`pathRegex`/`handler` used identically across Tasks 3/5/validate; `runHandler`/`compileHandler`/`HandlerReq`/`HandlerResp`/`HandlerCtx` consistent across Tasks 5/NetworkMockServer; `ensureCaInstalled`/`computeAndroidHash`/`Runner` consistent across Tasks 6/7; `getRootCaPemPath` added in Task 6 Step 1 and used in Step 4.

## Risks
- Task 1 outcome (user vs system store) changes Task 6's default `mode` and whether the emulator needs `-writable-system`.
- Shared-file resurrection (Task 2 Steps 2-4) is manual porting against main's diverged `types.ts`/`validate.ts`/`server.ts`; do it additively, `npm run check` after.
- vm `timeout` only bounds synchronous handler code; async is bounded by `Promise.race` (Task 5). Document that a handler awaiting forever is cut at the race timeout.
- Recording memory: cap buffered bodies (reuse beta's `slice(0, …)` caps) to avoid blowing memory on large responses.
