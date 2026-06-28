# Preflight Evidence Page Redesign - Design

Date: 2026-06-27
Status: Approved design, pending implementation plan
Owner: jeffjiang

Related: `docs/superpowers/specs/2026-06-27-preflight-live-viewer-redesign-design.md` (the live viewer; this evidence page is its frozen, post-run counterpart and reuses its components).

## 1. Context & Problem

After a run, `save_report` calls `writeEvidence` (`src/mcp/evidence.ts`), which writes two files under `~/.preflight/self-test-runs/<runId>/`:
- `evidence.md` - a flat markdown file that inlines the entire execution script and the full visualFlow JSON, plus a few flat sections.
- `metadata.json` - the raw run object.

There is no HTML page and no layout. The markdown dumps large blobs (script, visualFlow) the same way the old live viewer dumped raw JSON, so the "evidence page" reads as cluttered and crude.

## 2. Goals / Non-Goals

### Goals
- Replace `evidence.md` with a real HTML report page, `evidence.html`, using the new live-viewer design language.
- Self-contained as a folder: copy this run's screenshots and recording next to the HTML so the whole `<runId>/` folder can be moved, zipped, or attached to a code review.
- Reuse the live viewer's components (timeline, per-step screenshot strip, visual tokens) so live and evidence look like one product.
- Prominent PASS/FAIL verdict; on failure, surface the failure analysis and the failed step with its error screenshot.
- Move the script and visualFlow into a collapsed details section instead of inlining them.
- Also surface a one-glance verdict inline in the agent dialog (a composite image plus a link to the full report), not just on disk. See Section 11.

### Non-Goals
- No light/print theme. The user confirmed there is no print need; dark only.
- No live data (SSE, MJPEG stream). Evidence is static.
- No new device interaction. View-only, like the live viewer v1.
- Keep `metadata.json` as-is (machine-readable); this redesign does not change it.

## 3. Locked Decisions

- Output: `evidence.html` replaces `evidence.md`. `metadata.json` is unchanged. Assets are copied into `<runId>/assets/`.
- Portability: self-contained folder. `evidence.html` references `assets/...` with relative URLs only.
- Layout: two-pane (Direction B), dark, identical visual language to the live viewer. Chosen for visual consistency.
- The evidence page is the "frozen" live viewer: left pane is the recorded video replay (instead of the live MJPEG stream); the top bar is a PASS/FAIL verdict (instead of a RUNNING status); the right pane is the final-state step timeline (the same component); the bottom is artifact thumbnails plus a collapsed details disclosure (instead of a raw event log).

## 4. Layout & Components

Reuses the live viewer's full-height dark shell and visual tokens (accent `#3b82f6`, semantic green `#46d17f` / red `#e5484d`, radius 8px, mono numerics, zero em-dash).

### 4.1 Verdict bar (top, replaces the live status bar)
- Large `PASS` (green) or `FAIL` (red) verdict, then testIntent, step count (`8/8` on pass, `卡在 4/8` on fail), duration (mono), and a meta tail: platform, device, appRef, date.
- Duration is computed from `updatedAt - createdAt`.

### 4.2 Failure analysis banner (FAIL only)
- Directly under the verdict bar: a category chip (`failureAnalysis.category`, mono), the summary, and a `建议` line (`failureAnalysis.recommendation`). Hidden on PASS.

### 4.3 Body: left video + right timeline
- Left pane: recorded video replay, `<video src="assets/recording.mp4" controls preload="metadata">`. Same sizing model as the live device pane: full body height, width derived from the video aspect ratio (height x ratio), no letterbox. The recording is the device screen (scaled to `MIDSCENE_RECORD_VIDEO_SCALE_WIDTH`), so the aspect-locked sizing applies. This pane is kept on both PASS and FAIL.
- Right pane: the final-state step timeline, the same component as the live viewer (collapsed rows + an expandable step with the horizontal screenshot strip). All steps are terminal; statuses are passed/failed; steps after a failure render as a muted `未执行` group. On FAIL, the failed step is expanded by default with its error screenshot.

### 4.4 No-video fallback
- If no recording exists (recording disabled or failed), the left pane falls back to the run's last/error screenshot. If there is no usable screenshot either, the left pane collapses and the timeline takes the full width.

### 4.5 Bottom strip
- Artifact thumbnails: report.html, recording.mp4, screenshots (count), each a clickable tile pointing into `assets/` (or the original report for the HTML report link).
- A `<details>` disclosure, collapsed by default, containing the execution script and the visualFlow JSON. This replaces the old inline dumps.

## 5. Generation & Self-Containment (`writeEvidence` rewrite)

`writeEvidence` is rewritten to produce the self-contained folder:

1. Resolve this run's Midscene report dir from `run.reportDir` (added to RunState by the live-viewer work) and build the timeline via `buildTimelineFromReportDir` + `mergeWithVisualFlow` (the live-viewer modules).
2. Create `<runDir>/assets/screenshots/`. Copy every screenshot referenced by the timeline from the report dir into it (dedupe by filename). Rewrite each step's screenshot path to `assets/screenshots/<file>`.
3. Copy the recording into `<runDir>/assets/recording.mp4` if one exists (resolve from `run.artifacts` or the recorder output dir `<reportDir>/recordings/`).
4. Render `evidence.html` server-side using the shared step builders: verdict bar + (failure banner) + video pane + timeline (built from the rewritten relative asset URLs) + bottom artifacts + collapsed details. Self-contained, no network.
5. Write `metadata.json` as today.
6. Stop writing `evidence.md`. `WriteEvidenceResult` returns `{ runDir, evidencePath: <evidence.html>, metadataPath }`; `save_report` reports the HTML path.

## 6. Reuse & Architecture

The evidence page and the live viewer share one rendering core so they cannot drift:

- Extract a shared render layer from the live viewer's `src/mcp/live/page.ts`: the CSS tokens and the PURE HTML-string builders for a step (`collapsedHTML(step)` / `expandedHTML(step)`) plus the aspect-locked media-pane sizing JS. These builders take a `TimelineStep` and return a markup string with no DOM or fetch dependency, so both the browser (live) and Node (evidence) can call them.
- Parameterize by mode:
  - `live` mode: status bar + MJPEG `<img>` + SSE wiring + fallback poll; the browser calls the builders on each `/dump` refresh.
  - `evidence` mode: verdict bar + `<video>` + failure banner + collapsed details; Node calls the same builders at generation time to render the timeline HTML statically into the file.
- `evidence.html` is rendered server-side at `save_report` time (Node) using the shared builders, with all asset URLs relative to `assets/`. A small inline script handles only static interactivity (expand/collapse a step, video aspect sizing); there is no fetch or SSE.

Dependency note: this depends on the live-viewer modules `dumpTimeline.ts` (timeline build) and the shared render core in `page.ts`. The evidence implementation must run after, or be merged with, the live-viewer plan. See Risks.

## 7. Visual Language
Inherits the live viewer's tokens and craft rules verbatim (dark single theme, single accent, semantic-only status color, mono numerics, motion only if motivated, real screenshots, zero em-dash, full empty/error states). No new tokens.

## 8. Error / Empty / Edge States
- Missing report dir / no executed steps: render the verdict + meta + collapsed details; the timeline shows the pending visualFlow skeleton or an empty note; the body left pane shows the no-video fallback.
- No screenshots for a step: the strip shows a `本步无截图` note.
- A copied asset is missing at view time: the per-step image uses the same broken-asset placeholder behavior as the live viewer.
- Large asset sets: copying is acceptable per the chosen folder-portability model; dedupe screenshots to limit size.

## 9. Testing
- Unit: `writeEvidence` produces `evidence.html` + `assets/screenshots/*` + `assets/recording.mp4` (when a recording exists) + `metadata.json`, and does not write `evidence.md`; asset URLs in the HTML are relative (`assets/...`), never absolute.
- Unit: screenshot copy dedupes repeated filenames; timeline asset paths are rewritten.
- Unit: PASS vs FAIL rendering (verdict color, failure banner presence, failed step expanded) from a fixture `EvidenceRun` + fixture report dir.
- Unit: no-video fallback path selects the error/last screenshot.
- Manual: open a real `evidence.html` after a passing and a failing run; confirm video replays, timeline screenshots load from `assets/`, the folder still renders after being moved to another location, and details stays collapsed.

## 10. Risks & Open Questions
- Cross-plan dependency: relies on the live-viewer `dumpTimeline.ts` + shared render core. Recommendation: sequence the evidence plan after the live-viewer plan, or fold both into one execution stream so the shared render core is extracted once.
- Recording resolution: confirm the recording output path/artifact (the recorder writes `<reportDir>/recordings/<name>.mp4`); map it to `assets/recording.mp4`.
- Per-run screenshot scoping: same shared-report-dir caveat as the live viewer (Task 1 spike there); evidence reuses that resolution so it copies only this run's frames.
- Embedding timeline data inline vs a sibling `dump.json`: inline keeps it one HTML file; if the data is very large, fall back to a sibling `assets/timeline.json` fetched via relative URL (still works from `file://` for same-folder reads in most browsers; validate).

## 11. Inline evidence card in the agent dialog (save_report tool result)

Beyond the on-disk `evidence.html`, `save_report` returns a one-shot visual summary directly in the agent's chat, so the verdict is visible without opening a browser.

The tool result `content[]` becomes:
1. `text` - the verdict summary + paths (as today).
2. `image` - a composite PNG card (rendered via sharp): a verdict band (PASS green / FAIL red, with testIntent, step count, duration, platform/device; FAIL adds a `category · summary` line) above a filmstrip of up to 5 sampled key frames, the decisive frame emphasized (PASS = last frame, green outline; FAIL = failed step's frame, red outline) with step-number captions.
3. `resource_link` - `{ type: "resource_link", uri: "file://<runDir>/evidence.html", mimeType: "text/html", name }` for one-click open of the full report.

Generation:
- Build one SVG describing the whole card (band text + `<image>` elements embedding the base64-encoded, downscaled key frames + emphasis rects), then rasterize to a PNG via sharp and return it as a base64 `image` content block. One SVG to one raster avoids manual compositing math.
- Frame selection: from the timeline steps that have screenshots, sample up to 5 evenly; always include the decisive frame (the failed step on FAIL, the last step on PASS). Read the actual files from `<runDir>/assets/screenshots/` (already copied by the evidence generation).
- Size control: cap card width (~900px) and frame height (~160px); downscale the whole PNG to keep the base64 payload (and the agent's token cost) modest.

Client behavior and degradation:
- `image` renders inline in clients that support it (proven by the existing exploration screenshot tool). `resource_link` is a reference the client can open; it does not render the HTML inline.
- If sharp fails, there is no report dir, or there are no frames: return text-only (current behavior) plus the `resource_link` when `evidence.html` exists. Card generation never errors the tool.

Testing:
- Unit: the card generator returns a non-empty base64 PNG of the expected dimensions for a fixture run-dir with screenshots; FAIL includes the failed frame; returns `null` when no frames.
- Unit: the save_report content assembler returns `[text, image?, resource_link?]` with the image present only when a card was produced and the resource_link carrying a `file://` uri and `text/html` mimeType.

## 12. Out of Scope / Future
- Light/print theme.
- Diffing two evidence runs.
- A shared index page across runs.
- Zipping the folder automatically on `save_report`.
