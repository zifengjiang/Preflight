# Network Mock — Hardening Checklist (post-merge review of PR #2)

Reviewer findings on the merged network-mock code (on `main`). Fix on a branch `fix/network-mock-hardening` off `main`. Each item: `file:line — problem → fix`. Add a regression test per non-trivial fix. Verify on a rootable emulator and keep 留痕 LOCAL (see memory `verification-evidence-stays-local`). PR back to `main`.

3 finder candidates were **executed** and reproduced (marked ⚑).

## P0 — must fix (security / DoS; handler strings are often LLM-generated)

- [ ] ⚑ **vm sandbox escape → RCE** — `src/mcp/network-mocks/handler.ts:60-70`. The sandbox injects the MAIN-realm intrinsics `JSON/Math/Date/console`; `injectedJSON.constructor.constructor` is the host `Function`, so `()=>JSON.constructor.constructor("return process")().mainModule.require("child_process")...` runs host code. **Fix:** don't inject host objects — let the vm context provide its own intrinsics (or inject only frozen copies created *inside* the context). Delete the false "no process/require/Buffer/globalThis leakage" comment (line 44). Test: a handler trying `JSON.constructor.constructor` / `this.constructor` / returning a thenable cannot reach `process`/`require`.
- [ ] ⚑ **async handler hangs the event loop** — `handler.ts:71-74`. vm `timeout` only bounds the sync portion; `async()=>{while(true)await Promise.resolve()}` starves microtasks so the `Promise.race` macrotask never fires → whole agent wedged. **Fix:** run the handler in a `worker_thread` with a hard `terminate()` on timeout (bounds sync + async). Test: a busy-await handler returns/falls-through within the timeout, process stays responsive.
- [ ] ⚑ **ReDoS via hostRegex/pathRegex** — `NetworkMockServer.ts` (matching ~381/383, `hostnameMatchesAnyRule` ~641). User regex `^(a+)+$` is `.test()`'d on SNI/Host every request. **Fix:** cap regex source length in `validate.ts` + run matching with `re2` (linear) or a timeout. Test: a catastrophic-backtracking rule doesn't block.
- [ ] **CA private key world-readable in /tmp** — `NetworkMockServer.ts:741`. `writeFileSync(caKeyPath, rootCA.key)` has no mode (persisted CA at ~693 uses `0o600`). **Fix:** `{ mode: 0o600 }`.

## P1 — correctness / lifecycle

- [ ] **requestBodyMatch silently no-ops** — `findMatch` call sites `NetworkMockServer.ts:208,572` pass no body; `validate.ts` accepts it. Wrong canned response served, no error. **Fix:** reject `requestBodyMatch` in `validate.ts` (fail loud) — or buffer the request body before `findMatch` and actually use it.
- [ ] **waitForCompletion:false + abandoned run → device proxy left set** — `server.ts` (~272). **Fix:** failsafe teardown (TTL on the mock, or tear down on `stop_agent`/process exit).
- [ ] **watch_run tears down an unrelated run's mock** — `server.ts:319`; one global `networkMockService`, keyed on `isRunning()`+terminal, not runId. Kills manual record sessions / concurrent runs. **Fix:** key mock ownership to the runId that started it.
- [ ] **iOS "starts" with no proxy/CA** — `NetworkMockService.ts:28,49`; returns running but nothing intercepts; `start_network_mocks` accepts `ios`. **Fix:** reject `ios` loudly (out of v1 scope).
- [ ] **resourceId split drops adb-tcp serial** — `server.ts:234` `split(':')[1]` turns `android:127.0.0.1:5555` into `127.0.0.1`. **Fix:** strip only the leading `android:`/`ios:` prefix.
- [ ] **findMatch returns null instead of continue** — `NetworkMockServer.ts:427`; a callIndex-only rule passthrough-returns AND blocks later rules on the same host, and call count was already incremented. **Fix:** `continue` to the next rule; only count on an actual hit.
- [ ] **unanchored hostRegex over-matches** — `example.com` matches `evil-example.com` → decrypts unintended host. **Fix:** doc requires anchoring; `validate.ts` warns on obviously-broad patterns (or auto-anchor).
- [ ] **handler return value trusted** — bad `status` (e.g. 99999) / invalid header name throws in `res.writeHead` on the success path. **Fix:** validate/clamp `HandlerResp` before writing.

## P2 — minor + tests

- [ ] Object response body → `String(body)` = `"[object Object]"` with `application/json` (`validate.ts:104`). **Fix:** `JSON.stringify` objects, or reject non-string body.
- [ ] `proxy-authorization` not stripped on plain-HTTP forward (`NetworkMockServer.ts:452`; https/handler paths strip it). **Fix:** delete it there too.
- [ ] Dead code `isRootableAdbOutput` (`device-ca.ts:36`, doctor uses a different helper); `'unknown'` host fallback masks a bug (`NetworkMockServer.ts:64`); MITM'd TLS sockets have no idle timeout (fd leak on stalled CONNECT).
- [ ] **Test gaps:** `networkMockSni.test.ts:10` asserts a COPY of the SNI regex, not the production `handleConnectEvent` one; no test for "non-rule host is blind-tunneled" (selective MITM) or the `doctor` rootable gate. Add tests that exercise production code paths.

## Verify before merge
Rootable emulator: confirm mock hit / real passthrough / tunnel of non-rule host / handler (after sandbox fix) / recording full body / teardown restores proxy. Keep 留痕 local. PR to `main`.
