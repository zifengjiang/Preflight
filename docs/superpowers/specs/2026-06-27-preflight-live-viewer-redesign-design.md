# Preflight Live Viewer Redesign - Design

Date: 2026-06-27
Status: Approved design, pending implementation plan
Owner: jeffjiang

## 1. Context & Problem

During an agent run, Preflight opens a browser "live viewer" so the developer can watch the test. The current viewer (`src/mcp/liveViewer.ts`, `renderLivePage`) is a single light page that polls `GET /api/runs/:id` every 1.5s and renders:

- run status + a meta line (platform | resourceId | taskId)
- artifacts as plain text links
- a step list from `flowStepView` (index / type / status / duration / message only)
- a `<pre>` dump of `JSON.stringify(run, null, 2)` (the entire run object: all events, full script, full visualFlow)

Problems the user named: it is too crude and the information is cluttered. Concretely:

1. No device screen. You cannot see what the phone is doing, even though the runtime already records video every run and can read live frames.
2. The raw JSON `<pre>` is the worst offender for clutter.
3. Artifacts are text links; screenshots are not shown inline.
4. The step list is thin: no AI thought, no tap coordinates, no extracted data, no per-step screenshots.
5. Full re-poll of the whole run object every 1.5s.

## 2. Goals / Non-Goals

### Goals

- Live device screen as the primary element, smooth (video-like) on all three platforms (Android / iOS / Harmony).
- A decluttered, organized layout. The raw JSON dump becomes a collapsed, expandable raw event log.
- A smart step timeline: per-step Midscene screenshots plus AI thought, action + coordinates, extracted data, and failure reason.
- Push-based updates (SSE) instead of full polling.
- Show the current foreground app bundleId in the status bar.

### Non-Goals (this version)

- Controlling the device from the browser (tap/swipe injection). The live-debug input path exists and is a natural future extension, but v1 is view-only.
- A click-to-zoom lightbox for screenshots (future enhancement).
- A frontend build pipeline / framework. The viewer stays a dependency-free single HTML page (see Section 10).
- Replacing the final Midscene HTML report (`save_report`). This is the live monitor, not the archived report.

## 3. Design Read & Visual Language

Design read: a local dev-tool run monitor for one developer watching a single test, dark-tech language, leaning toward a restrained single-accent dashboard with monospace numerics and semantic-only status color.

This is product/dashboard UI, so we apply the anti-slop craft from the `design-taste-frontend` skill (not its landing-page layout rules):

- One locked theme: dark. No section inverts. (Light/auto is a possible future option, not v1.)
- One accent color (electric blue, e.g. `#3b82f6`). Status colors (green / red / amber) are used only to convey semantic state (run/step status, fallback), never as decoration.
- One corner-radius scale (8px).
- Monospace for all numbers, coordinates, durations, ids, and the bundleId.
- Motion only when motivated and minimal: LIVE pulse (state), current-step ring (hierarchy), new-step reveal (storytelling). All collapse under `prefers-reduced-motion`.
- Real images only (live stream + real Midscene screenshots). No div-based fake screenshots in the shipped UI.
- Zero em-dash in any visible string.
- Full interactive states: loading (skeleton matching layout), empty ("no run yet" / "waiting for first frame"), error (stream failed, screenshot 404).

Dials: VARIANCE 3 / MOTION 3 / DENSITY 5.

Fonts: system sans stack + system monospace stack (`ui-monospace, SFMono-Regular, ...`). No web-font dependency, so the viewer works offline as a local tool.

## 4. Layout & Components

Full-height single-page app (`100dvh`), three fixed regions plus two content panes:

```
┌───────────────────────────────────────────────────────────────┐
│ status bar (fixed)                                             │
├──────────────┬────────────────────────────────────────────────┤
│ device       │ step timeline (fills remaining width,          │
│ (live, full  │ internal vertical scroll)                      │
│  height,     │                                                │
│  width =     │                                                │
│  H × ratio)  │                                                │
├──────────────┴────────────────────────────────────────────────┤
│ bottom strip: artifact thumbnails + collapsed raw event log    │
└───────────────────────────────────────────────────────────────┘
```

### 4.1 Status bar (fixed, top)

Left to right: `Preflight` wordmark, run-status badge (`CREATED / RUNNING / SUCCESS / FAILED / CANCELLED`, semantic color, pulse only while RUNNING), platform + device label, foreground app bundleId (mono, in a subtle chip, live-updated), step progress `n/total` (mono), elapsed timer (mono), and testIntent truncated on the far right.

### 4.2 Device pane (left, the hero)

- Full height, no bezel, no border, no padding around the frame.
- Width is derived from the device aspect ratio: `width = paneHeight × (frameWidth / frameHeight)`. The pane is exactly as wide as the rendered frame, so there is never a letterbox black bar. The timeline begins immediately at the frame's right edge.
- Implementation: `<img id="screen" style="height:100%; width:auto; display:block; object-fit:contain">` inside a shrink-to-fit relative wrapper (`background:#000` only as a pre-load placeholder). A small JS guard sets `wrapper.style.width = wrapper.clientHeight × (img.naturalWidth / img.naturalHeight)` on first frame load and on `resize`, to avoid sub-pixel jitter in edge layouts. A CSS `aspect-ratio` fallback is set from the same ratio once known.
- `LIVE` badge overlays the top-left while streaming; switches to a muted `SNAPSHOT` label when running in fallback mode.

### 4.3 Step timeline (right)

Fills remaining width, internal vertical scroll; status bar and bottom strip stay fixed.

- Collapsed row (adopted from the reference `ExecutionDumpReport` list style): status-color glyph + step name + a one-line summary (reasoning/thought first, like the reference `oneLineSummary`) + mono duration. No inline thumbnail.
- Expanded step (one at a time): a card with two columns.
  - Left: text column with labeled fields - thought, action + coordinates, extracted data, and (on failure) failure reason.
  - Right: a horizontal, scrollable screenshot strip holding every screenshot of that step in chronological order. `display:flex; flex-wrap:nowrap; overflow-x:auto`; each thumbnail is `flex:0 0 auto` (fixed size, never compressed). Right-edge fade + visible scrollbar + light `scroll-snap-type:x` as affordances. A `N 张截图` counter sits below.
- Selection behavior: auto-follow the current running step (auto-expand it as it advances). If the user clicks any step, selection is pinned there and auto-follow pauses until they click the running step again (or a "follow live" affordance).
- Pending steps (planned but not yet executed) render as muted placeholder rows from the visualFlow skeleton.
- Failed step uses the semantic red treatment and shows thought + failure reason + the error screenshot in the strip.

### 4.4 Bottom strip (fixed)

- Artifact thumbnails: report.html, recording.mp4, screenshots (count), each a small clickable tile (replaces the old text links).
- "Raw event log" control, collapsed by default, expands to a scrollable structured event log. This replaces the old `JSON.stringify(run)` `<pre>` dump.

## 5. Live Device Stream

### 5.1 One browser-facing format

All three platforms converge on MJPEG consumed by a single `<img>` (`multipart/x-mixed-replace`). MJPEG in an `<img>` is the simplest smooth option and needs no decoder/MSE. Bandwidth is high but it is localhost.

### 5.2 Per-platform source (reuse proven, non-disruptive taps)

The video recorder (`src/infrastructure/midscene/videoRecorder.ts`) already taps these exact sources concurrently with the running task every run (`MIDSCENE_RECORD_VIDEO_ENABLED` defaults to "1" in `preflightRunDefaults`), which proves concurrency is safe.

- iOS: reverse-proxy the WDA MJPEG stream at `http://{wdaHost}:{mjpegPort}/` (mjpegPort defaults to wdaPort + 1000). Independent of the WDA WebDriver session (proven by `src/utils/iosMjpegCapture.ts`).
- Android: `adb exec-out screenrecord --output-format=h264 - | ffmpeg -i - -f mpjpeg -`. `screenrecord` has a ~3-minute cap, so the producer relaunches it in a loop and keeps the MJPEG response alive across restarts.
- Harmony: `hdc shell screenrecord ... -f h264 - | ffmpeg -i - -f mpjpeg -`.

`ffmpeg` is available via the bundled `@ffmpeg-installer/ffmpeg` (already used by the recorder) with PATH fallback.

### 5.3 Why not the live-debug session path

`DebugApplicationService.startLiveSession` already streams frames, but it (a) requires an active device lease (`leaseService.ensureActive`), which collides with the lease the running task holds, and (b) emits interval JPEG frames (a slideshow, not smooth). So we do not reuse it for the stream. We reuse only the standalone foreground parsers (Section 6).

### 5.4 Non-disruption & fallback

- The stream is a passive read; it never acquires a lease or device session.
- If the stream cannot start or breaks (no ffmpeg, source unavailable, mid-run error), fall back to periodic screenshots (adb/WDA/hdc screencap) into the same `<img>`, and switch the badge to `SNAPSHOT`. This is graceful degradation, not a hard failure.

### 5.5 Aspect ratio

Read client-side from the first frame's `naturalWidth/naturalHeight` and used to size the device pane (Section 4.2). No server round-trip needed.

## 6. Foreground App bundleId

A light, non-disruptive probe on an interval (e.g. 1.5s), reusing `src/utils/liveDebugForegroundParse.ts`:

- Android: `adb shell dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity|ResumedActivity"` (with window/top fallbacks) -> `parseAndroidForegroundFromDumpsys` -> `{ bundleId }`.
- Harmony: `aa dump -l` / `hidumper -s WindowManagerService -a` / `aa dump -a` -> `parseHarmonyForegroundFromShellDump` -> `{ bundleId, name?, pid? }`.
- iOS: WDA `GET http://{wdaHost}:{wdaPort}/wda/activeAppInfo` -> `{ bundleId }`.

The latest value is pushed to the browser over the SSE channel (Section 8) and rendered in the status bar; it updates as the foreground app changes.

## 7. Timeline Data & Per-Step Screenshots

### 7.1 Source of truth: the Midscene execution dump

Midscene writes the report incrementally to disk during the run as `N.execution.json` plus screenshot assets. We render that dump live, the same model the reference platform uses.

- `dump.executions[]` are the executed steps (one per AI action, e.g. "aiAct - 打开设置"). Each execution has `tasks[]` (Plan / Locate / Action / Insight), and each task can carry multiple screenshots (before-calling / after-calling).
- Timeline row = execution. The expanded view aggregates every screenshot across that execution's tasks, in chronological order (the reference's `collectScreenshotRelsForDumpTask` returns the per-task list; we concatenate across tasks).
- Rich fields per step come from the execution's tasks, parsed with the existing logic in `src/mcp/reportReader.ts` (thought from the Plan task, action type + `locate.center` coordinates + bbox from Action tasks, extracted data from Insight tasks, failure reason from a failed task).
- Status/timing reconcile with the existing `__FLOW_STEP_EVENT__` markers (`src/mcp/flowStepEvents.ts`) for liveness.

### 7.2 Combining executed + planned

- Executed steps come from the dump (rich).
- Remaining planned steps come from the visualFlow skeleton (`flattenVisualFlowSteps`) as muted pending rows.
- Step numbering follows the visualFlow order. Executed dump executions are matched to visualFlow step indices via the existing `__FLOW_STEP_EVENT__` `stepIndex` (already emitted per step), so numbering stays stable as steps move from pending to executed.
- This yields the "3/8, steps 4-8 pending" experience in one list.

### 7.3 Per-step screenshot component (adopted from the reference)

Mirror `DebugReportScreenshotImg.vue` behavior:

- Lazy `src`: only the expanded step binds image `src` (collapsed rows render no images). Equivalent to the reference `active` prop.
- Failed-URL cache: on image error, record the URL in a module-level set so SSE/poll refreshes never re-hammer a 404 (reference `debugScreenshotLoadState.ts`).
- `decoding="async"`.
- Asset URL carries a `_rev` cache-bust (reference `debugReportAssetUrl.ts`) so screenshots refresh as the report grows mid-run.

## 8. Realtime Data Flow

Replace the 1.5s full re-poll with SSE push + a fallback poll (the reference pattern).

- The live viewer exposes one SSE endpoint per run, `GET /runs/:id/events`, emitting:
  - `status`: run status, step progress (n/total), elapsed, currentStepIndex.
  - `foreground`: bundleId (Section 6).
  - `revision`: a monotonically increasing report-dump revision signal.
- On a new `revision`, the browser re-fetches `GET /runs/:id/dump` (the parsed timeline) and re-renders. Screenshots load lazily per Section 7.3.
- A ~15s fallback poll covers missed SSE messages (reference `TASK_DUMP_FALLBACK_POLL_MS`).
- No full-screen reload on update; the list and screenshots update in place.

## 9. Architecture & Components

To keep changes surgical and self-contained, all new runtime code lives on the MCP / live-viewer side (`src/mcp/`). The agent runtime's behavior and HTTP endpoints are left unchanged; the live viewer process taps the device and reads the report dir directly (both processes are local on the same machine, the same assumption the existing `read_report` / `save_report` flow already relies on). The only agent-side code we touch is to import (or lift into a shared util) the pure `resolveAutoSource` helper - no change to agent behavior.

### 9.1 RunState additions (`src/mcp/types.ts`, `runManager.ts`)

Persist on each run what the viewer needs: `platform`, `resourceId`, the resolved device-stream parameters (serial / wdaHost / wdaPort / mjpegPort, derived from `runtimeEnv`), and the resolved Midscene report dir path. `run_flow` already builds `runtimeEnv`; we capture the relevant fields here.

### 9.2 Live viewer (`src/mcp/liveViewer.ts`) - rewrite `renderLivePage` + add routes

Units, each with one clear purpose:

- Page renderer: the new full-height dark vanilla HTML/CSS/JS page (replaces `renderLivePage`).
- `GET /runs/:id/live`: serve the page (exists).
- `GET /api/runs/:id`: keep (back-compat / debugging).
- `GET /runs/:id/events`: SSE aggregator (status + foreground + revision).
- `GET /runs/:id/screen.mjpeg`: device stream producer (Section 5). Spawns the per-platform source -> ffmpeg mpjpeg, streams to the response; falls back to periodic screenshots.
- `GET /runs/:id/dump`: read the report dir from disk and return the parsed timeline `{ revision, steps[] }` (reuse/extend `reportReader.ts`).
- `GET /runs/:id/report/<assetRel>`: serve a screenshot/asset file from the report dir (with `_rev`).
- `GET /runs/:id/artifacts/<id>`: serve artifact bytes for the bottom-strip thumbnails (browsers cannot load `file://` from an http page).

### 9.3 Shared/reused helpers

- `src/utils/liveDebugForegroundParse.ts`: reuse the foreground parsers as-is.
- Device-source resolution: reuse or extract `resolveAutoSource` from `videoRecorder.ts` into a shared helper so the viewer and recorder agree on per-platform sources.
- `src/mcp/reportReader.ts`: extend to also surface per-step screenshot relative paths and a dir revision (e.g. max mtime / file count), and to be watchable (`fs.watch` on the report dir) to drive SSE revisions.

### 9.4 Server wiring (`src/mcp/server.ts`)

Pass `runtimeRoot` / report-dir resolution and device-stream params through to the live viewer; no change to MCP tools' external contract.

## 10. Tech Approach (dependency-free viewer)

The viewer remains a single self-contained HTML page served as a string from the live viewer server (the current `renderLivePage` pattern), with inline CSS and vanilla JS (`EventSource`, `fetch`, DOM). No framework, no bundler, since this ships in a published npm package and runs locally. This matches the user's preference for minimal, surgical change.

## 11. Error / Empty / Loading States

- No run / unknown runId: friendly empty state (current behavior returns 404; keep a clean message).
- Run created, no frames yet: device pane shows a "waiting for first frame" skeleton; timeline shows pending steps from the visualFlow skeleton.
- Stream cannot start / breaks: fall back to periodic screenshots, badge shows `SNAPSHOT`; never blank.
- Screenshot 404: failed-URL cache prevents re-requests; the thumbnail shows a subtle broken-asset placeholder.
- SSE drops: fallback poll keeps the view fresh; auto-reconnect EventSource.
- Terminal run (SUCCESS/FAILED/CANCELLED): stream stops; the last frame and full timeline remain; artifacts finalize in the bottom strip.

## 12. Testing

- Unit: dump -> timeline mapping (executed + pending merge), per-step screenshot aggregation/order, foreground parser reuse (already has tests in `src/tests/`), MJPEG first-frame extraction (existing `iosMjpegCapture` logic), failed-URL cache behavior.
- Integration: SSE revision -> dump re-fetch; fallback poll; stream-to-snapshot fallback path.
- Manual: run a real Android and iOS flow, confirm smooth stream, bundleId updates on app switch, timeline screenshots appear per step and the strip scrolls with many shots, device pane has no black bar at varied window heights, raw log stays collapsed.

## 13. Risks & Open Questions

- Android `screenrecord` ~3-minute cap: the relaunch loop must hand off without a visible gap; validate on a long run. Alternative if problematic: scrcpy-based raw pipe.
- Concurrent taps on Android: the recorder uses scrcpy `--record` while the live stream uses `adb screenrecord`; confirm they coexist without contention.
- Per-run report dir resolution: confirm how Preflight locates the per-run Midscene report dir (see `seedMidsceneTaskCache.ts`, `midsceneReportConstants.ts`, and the existing `save_report` path) so `/runs/:id/dump` and asset serving target the right directory.
- MJPEG multi-client (iOS): confirm WDA's MJPEG server allows the recorder and the live stream to read concurrently; if not, the viewer proxies a single upstream read to multiple browser clients.
- ffmpeg availability on the user's machine (bundled installer vs PATH); the snapshot fallback covers its absence.

## 14. Future Enhancements (out of scope)

- Click-to-zoom screenshot lightbox.
- Tap/swipe from the browser (reuse the live-debug input injection path).
- Light/auto theme.
- Multi-device view.

---

## 15. Resolved: Report Layout (Task 1 spike findings)

_Locked 2026-06-27. These findings are ground truth for Tasks 2-3._

### 15.1 Output mode in production runs

`preflightRunDefaults()` (`src/mcp/server.ts:341`) always injects `MIDSCENE_OUTPUT_FORMAT: "html-and-external-assets"` into every MCP-launched run's `runtimeEnv`. `TaskApplicationService.buildChildMidsceneEnv` only falls back to `"single-html"` when `runtimeEnv` contains no format override, which never happens for MCP-launched runs. Effective mode: **`html-and-external-assets`**.

### 15.2 Report directory layout (html-and-external-assets mode)

```
midscene_run/report/
└── <stem>/               ← bundleDir = getMidsceneReportRootDir() + "/" + stem
    ├── index.html        ← reportHtmlPath
    ├── 1.execution.json
    ├── 2.execution.json
    ├── N.execution.json  ← midscene writes dirname(reportHtmlPath)/N.execution.json
    └── screenshots/
        ├── <uuid>.png
        └── <uuid>.jpeg
```

`N.execution.json` files and `screenshots/` are siblings inside the per-run `bundleDir`, NOT flat in the report root. (The flat `N.execution.json` files visible in `midscene_run/report/` in the test dataset were produced by older `single-html` mode runs where `reportHtmlPath = report/<stem>.html` and `dirname = report/`.)

### 15.3 reportStem derivation

The stem is set by `TaskApplicationService.buildChildMidsceneEnv` (line 99):

```ts
MIDSCENE_FLOW_REPORT_STEM = buildMidsceneReportStemForTask(spec.requiredPlatform, String(taskId))
```

`buildMidsceneReportStemForTask` (in `src/utils/midsceneReportConstants.ts`) produces:

```
<platform_prefix>-task-<sanitized_taskId>-<startedAtMs>-<4hex>
```

where `platform_prefix` is one of `ios`, `android`, `harmony`, `web`.

Example: `ios-task-42-1779962668385-a3f7b2c1`

The live viewer resolves `bundleDir` as:

```
getMidsceneReportRootDir(cwd, env)  // = midscene_run/report
  + "/" + MIDSCENE_FLOW_REPORT_STEM
```

### 15.4 Screenshot field paths in execution.json

Verified across `1.execution.json`, `2.execution.json`, `17.execution.json`, and `30.execution.json` (the 138 KB file with 44 tasks). The schema is consistent across all files and all task types (Planning/Plan, Planning/Locate, Action Space/Tap, Action Space/Input, Action Space/Sleep, Insight/Query).

**Screenshot reference object** (same shape everywhere):

```json
{
  "type": "midscene_screenshot_ref",
  "id": "<uuid>",
  "capturedAt": 1779962668449,
  "mimeType": "image/jpeg" | "image/png",
  "storage": "inline"
}
```

Despite the `storage: "inline"` label, the image data is NOT embedded in the JSON as base64. The `id` is the UUID filename in the `screenshots/` sibling directory. Task 3 constructs the asset path as:

```
screenshots/<uuid>.<ext>   (ext from mimeType: "image/jpeg" -> ".jpeg", "image/png" -> ".png")
```

The live viewer serves it via `GET /runs/:id/report/screenshots/<uuid>.<ext>`.

**Where screenshots appear in a task object:**

| Field path | When present | Meaning |
|---|---|---|
| `task.uiContext.screenshot` | Always (every task that has a uiContext) | The screen state BEFORE this task ran |
| `task.recorder[N].screenshot` | On tasks that produce an after-action screenshot | The screen state AFTER calling (timing: `"after-calling"`) |

`task.recorder` is an array; each entry has `{ type: "screenshot", ts: <ms>, screenshot: { ...ref }, timing: "after-calling" }`. Most Action Space tasks and Planning/Plan tasks have exactly one recorder entry (the post-action shot). Planning/Locate and Action Space/Sleep may have zero or one.

**Thought field:**

| Field path | When present |
|---|---|
| `task.thought` | Planning/Plan tasks: the model's scratchpad reasoning BEFORE deciding the action |
| `task.output.thought` | Planning/Plan tasks: same field in the output object (both point to the same string) |

Insight/Query tasks have `task.thought` for the reasoning and `task.output` as a numeric-keyed object (the extracted data).

**Action fields (Action Space tasks):**

| Field path | Meaning |
|---|---|
| `task.subType` | Action type: `"Tap"`, `"Input"`, `"Sleep"`, etc. |
| `task.param.locate.description` | Natural-language description of the target element |
| `task.param.locate.center` | `[x, y]` coordinates (logical pixels) |
| `task.param.locate.rect` | `{ left, top, width, height }` bounding box |

### 15.5 Per-run scoping rule

Each run gets a unique `bundleDir = report/<stem>/`, but the stem is **not knowable from the MCP side**. `buildMidsceneReportStemForTask` (`src/utils/midsceneReportConstants.ts:53-60`) appends `Date.now()` and a random suffix, and it is called lazily inside the runtime at `TaskApplicationService.buildChildMidsceneEnv` (line 99), NOT in the MCP `run_flow` / `startRun` path. So `MIDSCENE_FLOW_REPORT_STEM` does not exist yet when `startRun` runs, and the viewer cannot reconstruct or pre-store it.

Resolution rule for the viewer:

1. At `startRun`, store the report **root** on RunState: `<runtimeRoot>/midscene_run/report` (stable and knowable; from `getMidsceneReportRootDir`). Also keep `run.createdAt`.
2. At read time, resolve the active per-run bundle dir by scanning `report/` for subdirectories that contain at least one `N.execution.json`, and pick the most-recently-modified one (optionally constrained to mtime >= `run.createdAt` to avoid selecting a stale prior run's bundle).
3. If no such per-run subdir exists, fall back to reading `N.execution.json` directly from the flat report root (older / single-html layout). This matches the plan's authorized fallback ("scope by mtime >= run.createdAt").

Once the bundle dir (or the flat root) is resolved, read the merged steps:

```
steps = mergeExecutionDumpJsonFromDir(resolvedDir).executions
```

`mergeExecutionDumpJsonFromDir` (already in `src/infrastructure/midscene/executionDumpWatcher.ts:27`) reads all `N.execution.json` files from a dir and merges their `executions[]` arrays in numeric order. Task 3 can reuse it directly.

### 15.6 Files consulted during spike

- `midscene_run/report/1.execution.json`, `2.execution.json`, `17.execution.json`, `30.execution.json` (real data)
- `node_modules/@midscene/core/dist/lib/report-generator.js` lines 60-216 (layout + screenshot storage)
- `src/infrastructure/transport/midscenePaths.ts` (resolveTaskReportFilePaths)
- `src/infrastructure/midscene/executionDumpWatcher.ts` (mergeExecutionDumpJsonFromDir, startExecutionDumpWatcher)
- `src/infrastructure/midscene/MidsceneRuntimeReal.ts` lines 487-557 (reportStem usage, bundleDir creation)
- `src/application/task/TaskApplicationService.ts` lines 95-109 (MIDSCENE_FLOW_REPORT_STEM injection)
- `src/utils/midsceneReportConstants.ts` (buildMidsceneReportStemForTask)
- `src/mcp/server.ts` lines 341-352 (preflightRunDefaults, MIDSCENE_OUTPUT_FORMAT default)
