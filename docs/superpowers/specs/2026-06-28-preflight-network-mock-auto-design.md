# Preflight Network Mock — Fully-Automatic on Android Emulator - Design

Date: 2026-06-28
Status: Approved direction, drafting design
Owner: jeffjiang

## 1. Context & Problem

A network-mock feature was built on the `beta` branch (commits `edc45e8`, `3cd4339`, `7b9296b`) and removed from `main` (`5349207`, "beta-only"). It is a local MITM HTTPS proxy:
- `src/mcp/network-mocks/NetworkMockServer.ts` — HTTP proxy + HTTPS MITM (CONNECT interception, per-host server certs signed by a self-generated root CA via the openssl CLI), rule matching (urlPattern/urlRegex/method/queryParams/callIndex/requestBodyMatch), recording, and **selective MITM** (`7b9296b`: only MITM hosts that match a rule; blind-tunnel everything else).
- `NetworkMockService.ts` (lifecycle), `device-proxy.ts` (Android emulator proxy via `adb shell settings put global http_proxy`), the `networkMocks` Visual Flow IR, and MCP tools (start/stop/status/update/get_ca/recording/export).

It works, but is **not fully automatic**: the documented flow requires the human to download, install, and trust the CA certificate on the device. That manual cert step is the blocker. On Android 7+ (API 24) user-installed CAs are not even trusted by apps unless the app opts in via `network-security-config`.

The user wants a **fully automatic** mock, **at least on the Android emulator**.

## 2. Goals / Non-Goals

### Goals
- Fully automatic network mock on the **Android emulator**: zero manual cert/proxy steps. `run_flow` with `networkMocks` just works.
- Reuse the beta proxy (server, rules IR, selective MITM, recording) — resurrect it, do not rewrite.
- Add the missing piece: **automatic CA trust on the emulator** (the cert pain dissolves on a rootable emulator).
- **Only the specified APIs are mocked; everything else passes through as real, untouched traffic.**
- Support **dynamic responses via an inline JS handler** per rule (compute / echo request params / inject values / transform the real upstream response), not only static canned bodies.
- First-class **record → export → replay**: record the real traffic of the specified hosts, export it to mock rules, lightly edit, and replay — so mocks can be authored without knowing the real payloads up front.

### Non-Goals (v1)
- iOS simulator / real devices. The user confirmed: with the emulator working, real devices are essentially unused. (Future: Section 14.)
- Certificate-pinning bypass. The target apps are developer-controlled, do not pin, and trust user CAs. No Frida/patching.
- Quantumult X auto-import, WebSocket interception. (Dynamic responses ARE in scope, via inline JS handlers — Section 8.)
- External-file handlers. Handlers are inline JS strings in the IR only (the user's choice, for a self-contained flow); a file-based handler form is out of scope for v1.

## 3. Locked Decisions

- Target: Android emulator only, on a **rootable** system image (`google_apis` or AOSP/`default`, NOT `google_apis_playstore`), so `adb root` works.
- The cert is installed automatically via root; no human steps, no Settings UI.
- Selective MITM: a host is MITM'd iff it matches some rule's `hostRegex`; all other hosts are blind-tunneled (never decrypted). Within a MITM'd host, only requests matching a rule's path (+ method/query/body) are mocked; everything else is forwarded to the real origin and returns real responses. Host matching is a regex (the user's choice, for flexibility).
- A matched rule produces its response from either static `responses[]` (param-based selection) or an inline JS `handler` string (arbitrary logic, may transform the real response via `ctx.fetchReal()`), run in a `vm` sandbox with a timeout. Inline strings only — no external handler files.
- Reuse the beta `network-mocks` module + IR + tools; add a new device-CA automation module; wire into `run_flow` lifecycle.

## 4. Architecture

```
visualFlow.networkMocks present
        │  (run_flow lifecycle: before launch)
        ▼
ensure rootable emulator ──▶ install Preflight CA (auto, root) ──▶ set global http_proxy ──▶ start NetworkMockServer
        │                                                                                          │
   android-emulator-setup                                                              selective MITM:
   (rootable AVD)                                                                      - rule host  → MITM → mock / forward-real
                                                                                       - other host → blind tunnel (real)
        │  (after run: success/fail/cancel)
        ▼
stop server ──▶ remove proxy (http_proxy :0) ──▶ leave CA installed (stable, reusable)
```

Three pieces:
1. **Reused (from beta):** `NetworkMockServer` (proxy + selective MITM + cert signing + rules + recording), `NetworkMockService` (lifecycle), `device-proxy.ts` (proxy set/remove), the `networkMocks` IR + validation + MCP tools, `MidsceneRuntimeMock.ts`.
2. **New:** `device-ca.ts` — automatic CA install/trust on the emulator (the core gap).
3. **New wiring:** `run_flow` starts/stops the mock around the flow when `networkMocks` is present.

## 5. The Fully-Automatic Pipeline

All steps scripted, zero human interaction:

1. **Ensure a rootable emulator.** Use the `android-emulator-setup` skill to create/boot an AVD from a `google_apis`/AOSP image (pinned API, e.g. 30-34). If the system-store fallback (5b) is needed, the emulator must be booted with `-writable-system`.
2. **`adb root`** (succeeds on non-Play images). Idempotent.
3. **Generate/load a stable Preflight Root CA** (reuse beta's openssl generation, but persist to `${PREFLIGHT_HOME}/network-mock-ca/ca.{key,pem}` so the subject hash is stable and the cert is reused across runs).
4. **Install the CA so apps trust it** (idempotent — skip if our hash is already present). See Section 6.
5. **Set the device proxy:** `adb shell settings put global http_proxy 10.0.2.2:<port>` (reuse `device-proxy.ts`). The emulator reaches the host at `10.0.2.2`.
6. **Start `NetworkMockServer`** bound on the host with the run's rules; selective MITM per Section 7.
7. **Teardown** (after the flow, any terminal status): stop the server, `settings put global http_proxy :0`. Leave the CA installed by default (stable + reusable); an opt-in flag can remove it.

## 6. Automatic CA Trust (the new core: `device-ca.ts`)

Android filename convention: a trusted CA is stored as `<subject_hash_old>.0` (PEM content). Compute it with `openssl x509 -inform PEM -subject_hash_old -in ca.pem -noout`.

Two install targets; an early spike picks the default for the chosen image and confirms the target app honors it:

- **Primary — user trust store on `/data` (no system remount):**
  `adb root`; `adb push` the `<hash>.0` to `/data/misc/user/0/cacerts-added/`; `chmod 644`; `chown` to the system uid as needed; `restorecon`. This lives on the always-writable `/data` partition (no `-writable-system`, no APEX gymnastics). It works because the target apps trust user CAs (confirmed by the user). Lightest path.
- **Fallback — system trust store (universally trusted):**
  boot the emulator with `-writable-system`; `adb root`; `adb remount`; push `<hash>.0` to `/system/etc/security/cacerts/`; `chmod 644`; reboot if required. On API ≥ 29 the system CAs live behind the conscrypt APEX; `-writable-system` + remount (or a tmpfs overlay of the cacerts dir) handles it. Heavier but bulletproof — any app trusts a system CA.

The spike validates the user-store path on the standardized image; if a target version does not honor `cacerts-added`, default to the system-store path. Either way it is fully scripted.

## 7. Matching Model: host-regex gates decryption, path gates mock

The hard TLS constraint that drives this: the decision to decrypt happens **before** decryption, at TLS-CONNECT time (the proxy CONNECT line / TLS SNI), where only the **host** is visible — the **path is inside the encrypted request**. So decryption can only be gated by host, never by path. Therefore each rule must specify the host; gating by path alone would force decrypting every host (maximal MITM, the opposite of the goal). This is why "limit to a domain" is not just allowed but required for minimal decryption.

Two gates:
- **Decryption gate (per connection, host-level):** at CONNECT, MITM the connection iff the host matches some rule's `hostRegex` (and is not in the connectivity-check passthrough list). Otherwise **blind tunnel** (`tunnelConnect`): a raw TCP relay, **no decryption**. So only the specified domain(s) are ever decrypted; all other domains stay opaque (and any pinning on them cannot break).
- **Mock gate (per request, path-level):** within a MITM'd (decrypted) host, a request is mocked iff it matches a rule's path (`pathPattern` substring or `pathRegex`) plus optional `method`/`queryParams`/`requestBodyMatch`/`callIndex`. Non-matching requests are forwarded to the real origin and return the real response.

Honest edge: other paths on a MITM'd host ARE decrypted (TLS is per-connection; you cannot selectively decrypt one path within a connection), but they are not parsed or altered — forwarded verbatim to the real server. Functionally equivalent to "not intercepted." Plain HTTP is handled the same way (host then path).

## 8. Mock Rule IR, MCP Tools, run_flow Lifecycle

- **IR (refined from beta):** `visualFlow.networkMocks?: NetworkMockRule[]`. The rule separates the decryption gate (host) from the mock gate (path), replacing beta's conflated full-URL `urlPattern`:
  ```
  NetworkMockRule {
    hostRegex: string            // REQUIRED — regex on the CONNECT host (SNI); gates MITM/decryption
    pathPattern?: string         // substring on the request path; OR
    pathRegex?:   string         // regex on the request path; if both omitted, all paths on the host
    method?: HTTPMethod
    queryParams?: Record<string, string>
    responses?: NetworkMockResponse[]   // static, param-based selection; XOR with handler
    handler?: string                    // inline JS source: (req, ctx) => response | null
    description?: string
  }
  NetworkMockResponse { status?, body, headers?, requestBodyMatch?, callIndex?, delay? }
  ```
  Restore the IR types + `validate.ts` rules + `visual-flow-ir-llm.md` docs that `5349207` stripped, adapting them to this host/path split (`validate.ts` requires `hostRegex`, rejects invalid regexes early, syntax-checks `handler`, and allows at most one of `responses`/`handler` — a rule with **neither** is a record-only rule: decrypt + record + forward real).

**Dynamic responses (inline JS handler).** When a rule has `handler` instead of `responses`, the matched request is passed to it and the handler computes the response:
- signature `handler(req, ctx) => response | null` (may be `async`).
- `req`: `{ method, host, path, query, headers, rawBody, json }` (`json` = parsed body when the body is JSON).
- `ctx`: `{ now(), uuid(), fetchReal() }` — `fetchReal()` awaits the real upstream response `{ status, headers, body }`, so the handler can transform real data.
- return `{ status?, headers?, body }` (`body` string or object→JSON), or `null`/`undefined` to forward the real response untouched.
- **Execution:** compiled once at mock start and run in a `node:vm` context whose scope is only `req`/`ctx` plus ECMAScript intrinsics (JSON/Math/Date) — no `process`/`require`/`Buffer`. A per-invocation timeout bounds it (sync via the vm `timeout` option; async via `Promise.race`); on timeout or throw, the request falls through to the real response.
- **Trust model:** the handler is local, user/LLM-authored test config executing in the agent's Node process (same trust as running any local test script); the vm sandbox + timeout are the guardrails. Deliberate for a local tool; an allowlist/disable switch can be added later.
- **MCP tools (reuse beta):** `start_network_mocks`, `stop_network_mocks`, `get_network_mock_status`, `update_network_mock_rules`, `get_root_ca_cert`, `start_recording`, `stop_recording`, `export_recorded_rules` — for manual record→export→replay workflows.
- **run_flow integration (new):** when the compiled flow has `networkMocks`, the lifecycle runs the Section 5 pipeline before launch and tears down after (any terminal status), so a single `run_flow` is fully automatic. Manual tools remain for iterative authoring.

**Record → Export → Replay (primary authoring workflow).** You often will not know the real payloads up front, so recording is the starting point: (1) add a **record-only rule** for the target API (just `hostRegex`, no `responses`/`handler`) so its host is MITM'd/decrypted; (2) `start_recording`, exercise the app, `stop_recording`; (3) `export_recorded_rules` turns the captured real request/response pairs into `NetworkMockRule[]` with **full** bodies (callIndex sequences + derived `requestBodyMatch`); (4) lightly edit the bodies and replay. Recording only sees decrypted (MITM'd) hosts — a host with no rule is tunneled and cannot be recorded. Full-body capture fidelity is required (Section 10).

## 9. Emulator Requirement

Standardize on a rootable AVD (a `google_apis`/AOSP image, pinned API, no Play Store). `android-emulator-setup` provisions it; `doctor` should detect a non-rootable (Play) image and report it as a blocker for mock runs. If the system-store fallback is chosen, the emulator must be (re)launched with `-writable-system`.

## 10. Reuse Inventory & Fixes

Resurrect from `beta` onto the implementation branch (reverse of `5349207`): `src/mcp/network-mocks/*` (5 files), `src/infrastructure/midscene/MidsceneRuntimeMock.ts`, `docs/network-mocks.md`, the `networkMocks` IR in `src/mcp/visual-flow/types.ts`, the mock validation in `validate.ts`, and the mock tool registrations + docs in `server.ts` / `visual-flow-ir-llm.md`.

Fixes applied while resurrecting:
- **Host/path matcher rework (the footgun):** beta's `hostnameMatchesAnyRule` tests the rule's full-URL `urlPattern` against a synthetic `https://<host>/`, so a `urlPattern` that includes a path never matches the host gate and that host is never decrypted. Replace with the explicit model: `hostnameMatchesAnyRule` tests `hostRegex` against the CONNECT host; `findMatch` tests `pathPattern`/`pathRegex` + method/query/body against the request. This is what makes "decrypt only domain X, mock only path Y" work.
- **Stable CA location:** persist the root CA to `${PREFLIGHT_HOME}/network-mock-ca/` (beta used `tmpdir()`), so the subject hash is stable, install is idempotent, and the cert survives across runs.
- **Recording fidelity (REQUIRED — recording is a primary workflow):** beta's `recordForwarded` overrides `res.end` and captures only the final chunk, truncating piped bodies. Fix by teeing at the stream level: when recording, accumulate the full upstream response body and the request body into capped buffers as they stream to/from the client, and record on stream `end` — do not rely on overriding `clientRes.end`. Without this, exported mocks have truncated bodies and the record→reuse workflow is broken.
- **openssl server-cert gen** uses bash process substitution (`shell: "/bin/bash"`); fine on the macOS dev env. Note for portability.

## 11. Error Handling, Teardown, Idempotency

- CA install is idempotent (skip if our `<hash>.0` is already present).
- If the emulator is not rootable (`adb root` fails / Play image): fail fast with a clear message pointing at the rootable-image requirement; do not silently run without mocks.
- If the proxy or server fails to start: do not launch the flow under a half-configured mock; report and abort the mock setup.
- Teardown always removes the proxy (`http_proxy :0`) even on failure/cancel; the server is stopped; the CA is left installed (reusable) unless an opt-in removal flag is set.
- Server cert generation failure for a host falls back to tunnel (beta behavior) so the device stays online.

## 12. Testing

- **Unit:** decryption gate (`hostRegex` match + passthrough list) vs mock gate (pathPattern/pathRegex/method/queryParams/callIndex/requestBodyMatch); the footgun regression (a rule with a path must still decrypt its host); Android CA hash filename derivation; `device-ca` command construction (with an injected runner, like the live-viewer `foregroundProbe` test) for both user-store and system-store paths; idempotency skip.
- **Integration:** start server → set proxy → a request to a mocked host+path returns the mock; a request to a non-mocked host is tunneled (real, never decrypted); a non-matching path on a mocked host is decrypted-but-forwarded (real).
- **Handler:** a sample inline handler runs in the vm and returns a computed body; `process`/`require` are absent in scope; an `async` handler using `ctx.fetchReal()` transforms the real response; a runaway handler is bounded by the timeout and falls through to real; `validate.ts` rejects a syntactically-broken handler and a `handler`+`responses` conflict.
- **Recording:** a multi-chunk upstream response is captured in full (not just the last chunk) and the request body is captured; `export_recorded_rules` yields a rule whose response body equals the full real body; a record-only rule (hostRegex, no responses/handler) triggers MITM + recording + real passthrough.
- **Emulator E2E (acceptance):** on a rootable emulator, `adb root` → install CA → verify a dev-controlled app's specified API returns the mock while other APIs return real data; confirm teardown restores the proxy. (Mirrors the evidence plan's Task 10 style: real stack, scripted checks.)

## 13. Risks & Open Questions

- **User-store recognition varies by API/image:** an early spike picks user-store vs system-store for the standardized image. System-store is the universal fallback.
- **System-store fallback needs `-writable-system` at AVD boot:** `android-emulator-setup` must support launching with that flag (or the emulator is relaunched). API ≥ 29 conscrypt-APEX adds remount nuance.
- **Non-Play image is mandatory** (`adb root` is refused on Play images). `doctor` surfaces this.
- **Reboot cost:** system-store install may need a reboot; user-store path avoids it (another reason it is the preferred default).
- **Host reachability:** emulator → host is `10.0.2.2` (beta already uses it); confirm the proxy binds on an interface the emulator can reach.

## 14. Out of Scope / Future
- iOS simulator (auto cert via `simctl keychain` + proxy) and the existing `.mobileconfig` path for real iOS.
- Real-device zero-setup by having the dev-controlled app bundle a debug `network-security-config` that trusts a fixed Preflight CA (no device cert step; works anywhere) — cheap because the apps are developer-controlled.
- Certificate-pinning bypass (Frida/objection).
- WebSocket interception, Quantumult X import.
- External-file / TypeScript handlers, and a curated handler allowlist or disable switch.
