# Preflight Evidence Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat `evidence.md` dump with a self-contained `evidence.html` report (folder-portable: `assets/` beside it), reusing the live viewer's timeline + per-step screenshot components, with a prominent PASS/FAIL verdict and failure analysis.

**Architecture:** Reuse the live viewer's data layer (`src/mcp/live/dumpTimeline.ts`) and extract its pure step-markup builders into a shared module used by both the live page (browser) and the evidence renderer (Node). `writeEvidence` is rewritten to build the timeline, copy this run's screenshots + recording into `<runDir>/assets/`, render `evidence.html` server-side, keep `metadata.json`, and stop writing `evidence.md`.

**Tech Stack:** TypeScript (ESM, Node >= 20.11), `node:fs/promises`, `node:test` + `node:assert/strict` (`tsx --test`), vanilla HTML/CSS/JS string output.

**Spec:** `docs/superpowers/specs/2026-06-27-preflight-evidence-page-redesign-design.md`

## DEPENDENCY (read first)

This plan REUSES live-viewer modules that are built by `docs/superpowers/plans/2026-06-27-preflight-live-viewer-redesign.md`:

- `src/mcp/live/dumpTimeline.ts` - `buildTimelineFromReportDir`, `mergeWithVisualFlow`, `TimelineView`, `TimelineStep` (live-viewer Task 3).
- `src/mcp/live/page.ts` - contains the per-step markup builders + CSS (live-viewer Task 8).
- `RunState.reportDir` (live-viewer Task 2).

Therefore: **execute this plan on a branch that already contains the merged live-viewer implementation** (e.g., branch off `main` after `feat/live-viewer-redesign` lands). Task 1 verifies these symbols exist before proceeding.

**Conventions:** 2-space indent, double quotes, `.js` import suffixes for local ESM, no default exports. Type check `npm run check`; tests `npm test`.

---

## Task 1: Verify dependency + extract shared step-markup module

Locks reuse. Moves the pure markup builders out of `page.ts` into a shared module both the browser (live) and Node (evidence) use, so the two views cannot drift.

**Files:**

- Create: `src/mcp/live/timelineMarkup.ts`
- Modify: `src/mcp/live/page.ts`
- Test: `src/tests/timelineMarkup.test.ts`

- [ ] **Step 1: Verify the live-viewer modules exist**

Run:

```bash
cd /Users/didi/Documents/preflight
test -f src/mcp/live/dumpTimeline.ts && grep -q "export function buildTimelineFromReportDir" src/mcp/live/dumpTimeline.ts && echo OK-dump || echo MISSING-dump
test -f src/mcp/live/page.ts && echo OK-page || echo MISSING-page
grep -q "reportDir" src/mcp/types.ts && echo OK-reportDir || echo MISSING-reportDir
```

Expected: `OK-dump`, `OK-page`, `OK-reportDir`. If any are MISSING, stop: the live-viewer plan is not yet merged into this branch.

- [ ] **Step 2: Write the failing test for the shared builders**

`src/tests/timelineMarkup.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { stepCollapsedHTML, stepExpandedHTML } from "../mcp/live/timelineMarkup.ts";

const step = {
  index: 3, title: "aiAct 打开设置", status: "finished" as const, summary: "点右上角齿轮",
  thought: "点右上角齿轮", action: { type: "Tap", target: "设置入口", center: [320, 96] as [number, number] },
  screenshots: ["assets/screenshots/b1.png", "assets/screenshots/b2.png"],
};

test("collapsed row shows index, title, status glyph", () => {
  const html = stepCollapsedHTML(step);
  assert.match(html, /3 aiAct/);
  assert.match(html, /✓/);
});

test("expanded step renders each screenshot URL verbatim (no host rewrite)", () => {
  const html = stepExpandedHTML(step);
  assert.match(html, /assets\/screenshots\/b1\.png/);
  assert.match(html, /assets\/screenshots\/b2\.png/);
  assert.match(html, /320, 96/);
});
```

- [ ] **Step 3: Run to verify fail**

Run: `npm test -- --test-name-pattern="collapsed row|expanded step renders"`
Expected: FAIL (module `timelineMarkup.ts` not found).

- [ ] **Step 4: Create `src/mcp/live/timelineMarkup.ts`**

Move the pure builders here (copy the bodies currently inline in `page.ts`). They must be pure string functions (no DOM, no fetch), taking a `TimelineStep` and an optional base for screenshot URLs already baked into `step.screenshots`:

```typescript
import type { TimelineStep } from "./dumpTimeline.js";

const GLYPH: Record<string, string> = { finished: "✓", failed: "✗", running: "●", pending: "○" };

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&", "<": "<", ">": ">" }[c] as string));
}

export function stepCollapsedHTML(s: TimelineStep): string {
  const dur = s.durationMs != null ? `<span class="dur">${(s.durationMs / 1000).toFixed(1)}s</span>` : "";
  return `<div class="step ${s.status}" data-step="${s.index}"><span class="g ${s.status}">${GLYPH[s.status] ?? ""}</span>`
    + `<span class="t"><b>${s.index} ${esc(s.title)}</b> <span class="sub">${esc(s.summary)}</span></span>${dur}</div>`;
}

export function stepExpandedHTML(s: TimelineStep): string {
  const shots = (s.screenshots ?? [])
    .map((rel, i) => `<figure><img loading="lazy" decoding="async" src="${esc(rel)}" onerror="this.closest('figure').classList.add('broken')"><figcaption>${i + 1}</figcaption></figure>`)
    .join("") || `<span class="sub">本步无截图</span>`;
  const action = s.action ? `动作 ${esc(s.action.type)}${s.action.center ? ` (${s.action.center.join(", ")})` : ""}` : "";
  return `<div class="step expanded ${s.status}" data-step="${s.index}"><div class="head"><b>${s.index} ${esc(s.title)}</b></div>`
    + `<div class="cols"><div class="text">`
    + (s.thought ? `<div><span class="lbl">思考</span> ${esc(s.thought)}</div>` : "")
    + (action ? `<div><span class="lbl">${action}</span></div>` : "")
    + (s.error ? `<div class="err"><span class="lbl">原因</span> ${esc(s.error)}</div>` : "")
    + `</div><div class="strip">${shots}</div></div></div>`;
}
```

- [ ] **Step 5: Refactor `page.ts` to use the shared builders for both contexts**

In `page.ts`, import the builders for any server-side use, and for the browser, inject their source into the client script so the live page uses the exact same code:

```typescript
import { stepCollapsedHTML, stepExpandedHTML } from "./timelineMarkup.js";
// ...in the returned HTML's <script>, inject the function sources:
//   ${stepCollapsedHTML.toString()}\n${stepExpandedHTML.toString()}\n
// and have the client renderTimeline() call stepCollapsedHTML / stepExpandedHTML.
```

Remove the now-duplicated inline builder definitions from the client script (the injected `.toString()` versions replace them). Keep `renderTimeline`, SSE wiring, and sizing JS as-is.

- [ ] **Step 6: Run tests + type check**

Run: `npm test -- --test-name-pattern="collapsed row|expanded step renders"` (PASS), then `npm run check` (no errors), then `npm test` (all pass). Manually confirm the live page still renders a run (smoke).

- [ ] **Step 7: Commit**

```bash
git add src/mcp/live/timelineMarkup.ts src/mcp/live/page.ts src/tests/timelineMarkup.test.ts
git commit -m "refactor(live): extract shared step-markup builders for reuse by evidence"
```

---

## Task 2: EvidenceRun carries reportDir

**Files:**

- Modify: `src/mcp/types.ts`
- Modify: `src/mcp/server.ts`

- [ ] **Step 1: Add reportDir to EvidenceRun**

In `src/mcp/types.ts`, add to the `EvidenceRun` interface (after `visualFlow?: unknown;`):

```typescript
  /** Absolute Midscene report dir for this run (from RunState). */
  reportDir?: string;
```

- [ ] **Step 2: Pass it through in save_report**

In `src/mcp/server.ts`, the `save_report` handler builds `run: { ...run, status, failureAnalysis }`. Since `run` is the `RunState` (which now has `reportDir` from the live-viewer work), the spread already carries `reportDir`. Verify by adding `reportDir: run.reportDir` explicitly to the object passed to `writeEvidence` so the dependency is obvious.

- [ ] **Step 3: Type check + commit**

Run: `npm run check`.

```bash
git add src/mcp/types.ts src/mcp/server.ts
git commit -m "feat(evidence): carry reportDir into EvidenceRun for asset resolution"
```

---

## Task 3: Asset copier (screenshots + recording -> assets/)

**Files:**

- Create: `src/mcp/live/evidenceAssets.ts`
- Test: `src/tests/evidenceAssets.test.ts`

- [ ] **Step 1: Write the failing test**

`src/tests/evidenceAssets.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyRunAssets } from "../mcp/live/evidenceAssets.ts";

test("copies referenced screenshots into assets/ and rewrites paths, dedupes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-assets-"));
  const reportDir = join(root, "report");
  await mkdir(join(reportDir, "screenshots"), { recursive: true });
  await writeFile(join(reportDir, "screenshots", "a.png"), "x");
  const runDir = join(root, "run");
  await mkdir(runDir, { recursive: true });

  const steps = [
    { index: 1, title: "t", status: "finished" as const, summary: "", screenshots: ["screenshots/a.png"] },
    { index: 2, title: "t", status: "finished" as const, summary: "", screenshots: ["screenshots/a.png"] }, // dup
  ];
  const out = await copyRunAssets({ reportDir, runDir, steps });
  const copied = await readdir(join(runDir, "assets", "screenshots"));
  assert.deepEqual(copied, ["a.png"]); // deduped
  assert.equal(out.steps[0].screenshots[0], "assets/screenshots/a.png"); // rewritten
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test -- --test-name-pattern="copies referenced screenshots"`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/mcp/live/evidenceAssets.ts`**

```typescript
import { mkdir, copyFile, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import type { TimelineStep } from "./dumpTimeline.js";

export interface CopyAssetsInput { reportDir: string; runDir: string; steps: TimelineStep[]; }
export interface CopyAssetsResult { steps: TimelineStep[]; recordingRel?: string; }

export async function copyRunAssets(input: CopyAssetsInput): Promise<CopyAssetsResult> {
  const shotsOut = join(input.runDir, "assets", "screenshots");
  await mkdir(shotsOut, { recursive: true });
  const seen = new Map<string, string>(); // rel -> assets rel
  for (const step of input.steps) {
    for (const rel of step.screenshots) {
      if (seen.has(rel)) continue;
      const src = join(input.reportDir, rel);
      const name = basename(rel);
      if (existsSync(src)) await copyFile(src, join(shotsOut, name)).catch(() => {});
      seen.set(rel, `assets/screenshots/${name}`);
    }
  }
  const steps = input.steps.map((s) => ({ ...s, screenshots: s.screenshots.map((r) => seen.get(r) ?? r) }));

  // recording: newest mp4 under <reportDir>/recordings/
  let recordingRel: string | undefined;
  const recDir = join(input.reportDir, "recordings");
  if (existsSync(recDir)) {
    const mp4s = (await readdir(recDir)).filter((f) => f.endsWith(".mp4"));
    if (mp4s.length) {
      const withTime = await Promise.all(mp4s.map(async (f) => ({ f, t: (await stat(join(recDir, f))).mtimeMs })));
      const newest = withTime.sort((a, b) => b.t - a.t)[0]!.f;
      await mkdir(join(input.runDir, "assets"), { recursive: true });
      await copyFile(join(recDir, newest), join(input.runDir, "assets", "recording.mp4")).catch(() => {});
      if (existsSync(join(input.runDir, "assets", "recording.mp4"))) recordingRel = "assets/recording.mp4";
    }
  }
  return { steps, recordingRel };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- --test-name-pattern="copies referenced screenshots"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/live/evidenceAssets.ts src/tests/evidenceAssets.test.ts
git commit -m "feat(evidence): copy run screenshots and recording into assets/"
```

---

## Task 4: Evidence HTML renderer

**Files:**

- Create: `src/mcp/live/evidencePage.ts`
- Test: `src/tests/evidencePage.test.ts`

- [ ] **Step 1: Write the failing test**

`src/tests/evidencePage.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEvidenceHTML } from "../mcp/live/evidencePage.ts";

const base = {
  runId: "r1", taskId: "t1", status: "SUCCESS", platform: "ANDROID", resourceId: "pixel-7",
  appRef: "com.demo", testIntent: "打开设置", createdAt: "2026-06-27T14:00:00Z", updatedAt: "2026-06-27T14:02:14Z",
  liveUrl: "", artifacts: [], failureAnalysis: { category: "none", summary: "", recommendation: "" },
} as const;
const steps = [{ index: 1, title: "launch", status: "finished" as const, summary: "", screenshots: [] }];

test("PASS renders green verdict and no failure banner; no absolute asset paths", () => {
  const html = renderEvidenceHTML({ run: { ...base }, steps, recordingRel: "assets/recording.mp4" });
  assert.match(html, /PASS/);
  assert.doesNotMatch(html, /failure-banner/);
  assert.doesNotMatch(html, /file:\/\//);
  assert.match(html, /assets\/recording\.mp4/);
});

test("FAIL renders red verdict + failure banner with category/recommendation", () => {
  const run = { ...base, status: "FAILED", failureAnalysis: { category: "test-or-app-behavior", summary: "断言失败", recommendation: "增加 sleep" } };
  const failStep = { index: 2, title: "assert", status: "failed" as const, summary: "", screenshots: [], error: "title 实为 我的" };
  const html = renderEvidenceHTML({ run, steps: [...steps, failStep], recordingRel: undefined });
  assert.match(html, /FAIL/);
  assert.match(html, /failure-banner/);
  assert.match(html, /test-or-app-behavior/);
  assert.match(html, /增加 sleep/);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test -- --test-name-pattern="PASS renders green|FAIL renders red"`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/mcp/live/evidencePage.ts`**

Renders the full static document using the shared builders + the live CSS tokens. Pass = green verdict, fail = red verdict + `failure-banner`. Left pane: `<video src="${recordingRel}">` when present, else the no-video fallback (Task 6). Timeline built server-side from steps (failed step expanded). Bottom: artifacts + `<details>` with script + visualFlow.

```typescript
import type { EvidenceRun, TimelineStep } from ...; // EvidenceRun from ../types.js; TimelineStep from ./dumpTimeline.js
import { stepCollapsedHTML, stepExpandedHTML } from "./timelineMarkup.js";
import { EVIDENCE_CSS } from "./timelineMarkup.js"; // export the shared CSS string from timelineMarkup (add in Task 1 if not already)

export interface RenderEvidenceInput { run: EvidenceRun; steps: TimelineStep[]; recordingRel?: string; }

export function renderEvidenceHTML(input: RenderEvidenceInput): string {
  const { run, steps, recordingRel } = input;
  const pass = run.status === "SUCCESS";
  const verdict = pass ? "PASS" : "FAIL";
  const durationMs = Date.parse(run.updatedAt) - Date.parse(run.createdAt);
  const dur = Number.isFinite(durationMs) ? new Date(Math.max(0, durationMs)).toISOString().slice(14, 19) : "";
  const failedIdx = steps.find((s) => s.status === "failed")?.index;
  const timeline = steps.map((s) => (s.index === failedIdx || (pass && s.index === steps[steps.length - 1]?.index)) ? stepExpandedHTML(s) : stepCollapsedHTML(s)).join("");
  const banner = pass ? "" :
    `<div class="failure-banner"><span class="cat">${esc(run.failureAnalysis.category)}</span> ${esc(run.failureAnalysis.summary)}<div class="rec"><span class="lbl">建议</span> ${esc(run.failureAnalysis.recommendation)}</div></div>`;
  const media = recordingRel
    ? `<video src="${esc(recordingRel)}" controls preload="metadata"></video>`
    : `<div class="novideo">无录屏</div>`;
  const details = `<details><summary>详情（脚本 / visualFlow）</summary><pre>${esc(run.script ?? "")}</pre><pre>${esc(JSON.stringify(run.visualFlow ?? {}, null, 2))}</pre></details>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Evidence ${esc(run.runId)}</title><style>${EVIDENCE_CSS}</style></head>`
    + `<body class="evidence ${pass ? "pass" : "fail"}">`
    + `<div class="verdict"><span class="big">${verdict}</span> <span>${esc(run.testIntent ?? "")}</span> <span class="meta">${esc(run.platform ?? "")} · ${esc(run.resourceId ?? "")} · ${esc(run.appRef ?? "")} · ${dur}</span></div>`
    + banner
    + `<div class="body"><div id="device" class="media">${media}</div><div id="timeline">${timeline}</div></div>`
    + `<div class="bottom">${details}</div>`
    + `<script>document.getElementById('timeline').addEventListener('click',e=>{const el=e.target.closest('[data-step]');/* static expand/collapse toggle */});const v=document.querySelector('#device video');function fit(){const d=document.getElementById('device');if(v&&v.videoWidth){d.style.width=(d.clientHeight*v.videoWidth/v.videoHeight)+'px';}}if(v){v.addEventListener('loadedmetadata',fit);addEventListener('resize',fit);}</script>`
    + `</body></html>`;
  function esc(s){return String(s ?? "").replace(/[&<>]/g,c=>({"&":"&","<":"<",">":">"}[c]));}
}
```

Note: export `EVIDENCE_CSS` from `timelineMarkup.ts` (the shared dark tokens + `.step/.strip/.verdict/.failure-banner/.body/.media/#device/#timeline` rules) in Task 1 so both pages share it. Add the `.verdict/.failure-banner/.media` rules there.

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- --test-name-pattern="PASS renders green|FAIL renders red"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/live/evidencePage.ts src/mcp/live/timelineMarkup.ts src/tests/evidencePage.test.ts
git commit -m "feat(evidence): server-side evidence.html renderer (verdict + timeline + video)"
```

---

## Task 5: Rewrite writeEvidence + wire save_report

**Files:**

- Modify: `src/mcp/evidence.ts`
- Test: `src/tests/evidence.test.ts`

- [ ] **Step 1: Write the failing test**

`src/tests/evidence.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEvidence } from "../mcp/evidence.ts";

test("writeEvidence emits evidence.html + assets + metadata.json and NOT evidence.md", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-"));
  const reportDir = join(root, "report");
  await mkdir(join(reportDir, "screenshots"), { recursive: true });
  await writeFile(join(reportDir, "1.execution.json"), JSON.stringify({ executions: [{ name: "Launch", tasks: [{ type: "Action Space", subType: "Launch", status: "finished", uiContext: { screenshot: { path: "./screenshots/a.png" } } }] }] }));
  await writeFile(join(reportDir, "screenshots", "a.png"), "x");

  const out = await writeEvidence({
    outputRoot: root,
    run: { runId: "r1", taskId: "t1", status: "SUCCESS", platform: "ANDROID", resourceId: "pixel-7", appRef: "com.demo", testIntent: "x", createdAt: "2026-06-27T14:00:00Z", updatedAt: "2026-06-27T14:02:00Z", liveUrl: "", artifacts: [], failureAnalysis: { category: "none", summary: "", recommendation: "" }, reportDir },
  });

  assert.ok(out.evidencePath.endsWith("evidence.html"));
  const html = await readFile(out.evidencePath, "utf8");
  assert.match(html, /PASS/);
  assert.match(html, /assets\/screenshots\/a\.png/);
  await access(out.metadataPath); // metadata.json exists
  const files = await readdir(join(root, "self-test-runs", "r1"));
  assert.ok(!files.includes("evidence.md"));
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test -- --test-name-pattern="writeEvidence emits"`
Expected: FAIL (current writeEvidence writes evidence.md).

- [ ] **Step 3: Rewrite `writeEvidence` in `src/mcp/evidence.ts`**

```typescript
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EvidenceRun } from "./types.js";
import { buildTimelineFromReportDir, mergeWithVisualFlow } from "./live/dumpTimeline.js";
import { copyRunAssets } from "./live/evidenceAssets.js";
import { renderEvidenceHTML } from "./live/evidencePage.js";

export interface WriteEvidenceInput { run: EvidenceRun; outputRoot?: string; }
export interface WriteEvidenceResult { runDir: string; evidencePath: string; metadataPath: string; }

export async function writeEvidence(input: WriteEvidenceInput): Promise<WriteEvidenceResult> {
  const runDir = join(input.outputRoot ?? join(homedir(), ".preflight"), "self-test-runs", input.run.runId);
  await mkdir(runDir, { recursive: true });
  const evidencePath = join(runDir, "evidence.html");
  const metadataPath = join(runDir, "metadata.json");

  const view = input.run.reportDir
    ? mergeWithVisualFlow(await buildTimelineFromReportDir(input.run.reportDir), input.run.visualFlow)
    : { revision: 0, steps: [] };
  const assets = input.run.reportDir
    ? await copyRunAssets({ reportDir: input.run.reportDir, runDir, steps: view.steps })
    : { steps: view.steps, recordingRel: undefined };

  await writeFile(evidencePath, renderEvidenceHTML({ run: input.run, steps: assets.steps, recordingRel: assets.recordingRel }), "utf8");
  await writeFile(metadataPath, JSON.stringify(input.run, null, 2), "utf8");
  return { runDir, evidencePath, metadataPath };
}
```

Delete the old `renderEvidenceMarkdown` function and the `evidence.md` write.

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- --test-name-pattern="writeEvidence emits"`
Expected: PASS.

- [ ] **Step 5: Confirm save_report still compiles**

`server.ts` `save_report` already calls `writeEvidence({ outputRoot: preflightHome, run: {...} })` and returns its result via `jsonResult`. Run `npm run check`. The returned `evidencePath` now points at `evidence.html`; update any user-facing text in `setup.ts` that says "evidence.md" to "evidence.html" (search `evidence.md`).

- [ ] **Step 6: Commit**

```bash
git add src/mcp/evidence.ts src/tests/evidence.test.ts src/mcp/setup.ts
git commit -m "feat(evidence): write self-contained evidence.html instead of evidence.md"
```

---

## Task 6: No-video fallback, empty/edge states

**Files:**

- Modify: `src/mcp/live/evidencePage.ts`
- Modify: `src/mcp/live/evidenceAssets.ts`
- Test: `src/tests/evidencePage.test.ts` (extend)

- [ ] **Step 1: Failing test for no-video fallback**

Add to `src/tests/evidencePage.test.ts`:

```typescript
test("no recording: left pane falls back to error/last screenshot", () => {
  const run = { ...base, status: "FAILED", failureAnalysis: { category: "x", summary: "y", recommendation: "z" } };
  const failStep = { index: 2, title: "assert", status: "failed" as const, summary: "", screenshots: ["assets/screenshots/err.png"], error: "e" };
  const html = renderEvidenceHTML({ run, steps: [failStep], recordingRel: undefined });
  assert.match(html, /assets\/screenshots\/err\.png/); // shown in media pane
  assert.doesNotMatch(html, /<video/);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test -- --test-name-pattern="no recording"`
Expected: FAIL.

- [ ] **Step 3: Implement the fallback**

In `renderEvidenceHTML`, when `recordingRel` is absent, pick a fallback image: the failed step's last screenshot, else the last step's last screenshot, else a `无画面` placeholder. Render `<img class="media-shot" src="...">` in `#device` instead of `<video>`. When neither video nor screenshot exists, render the placeholder and add a class so CSS lets `#timeline` take full width.

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- --test-name-pattern="no recording"`
Expected: PASS. Then `npm test` (all) + `npm run check`.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/live/evidencePage.ts src/mcp/live/evidenceAssets.ts src/tests/evidencePage.test.ts
git commit -m "feat(evidence): no-video fallback and empty-state handling"
```

---

## Task 7: End-to-end manual verification

- [ ] **Step 1: Pass run**

Run a real passing flow, then `save_report`. Open the returned `evidence.html`. Verify: green PASS verdict, video replays, timeline screenshots load from `assets/`, details collapsed, no `evidence.md` in the folder.

- [ ] **Step 2: Fail run**

Run a flow that fails an assert, then `save_report`. Verify: red FAIL verdict, failure banner (category/summary/recommendation), failed step expanded with error screenshot, video still present.

- [ ] **Step 3: Portability**

Move the whole `<runId>/` folder elsewhere and reopen `evidence.html`; confirm video + screenshots still render (all relative `assets/`).

- [ ] **Step 4: No-video**

Disable recording (or simulate a missing recording), `save_report`, confirm the media pane falls back to the error/last screenshot and the layout stays clean.

---

## Task 8: Inline composite card generator (sharp)

**Files:**
- Create: `src/mcp/live/evidenceCard.ts`
- Modify: `src/mcp/evidence.ts` (extend `WriteEvidenceResult` + call the generator)
- Test: `src/tests/evidenceCard.test.ts`

- [ ] **Step 1: Write the failing test**

`src/tests/evidenceCard.test.ts`:
```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEvidenceCardPng } from "../mcp/live/evidenceCard.ts";

const run = {
  runId: "r1", taskId: "t1", status: "SUCCESS", platform: "ANDROID", resourceId: "pixel-7",
  appRef: "com.demo", testIntent: "打开设置", createdAt: "2026-06-27T14:00:00Z", updatedAt: "2026-06-27T14:02:00Z",
  liveUrl: "", artifacts: [], failureAnalysis: { category: "none", summary: "", recommendation: "" },
} as const;

async function fixtureRunDir() {
  const runDir = await mkdtemp(join(tmpdir(), "card-"));
  await mkdir(join(runDir, "assets", "screenshots"), { recursive: true });
  const png = await sharp({ create: { width: 9, height: 16, channels: 3, background: "#123456" } }).png().toBuffer();
  await writeFile(join(runDir, "assets", "screenshots", "a.png"), png);
  return runDir;
}

test("returns a base64 PNG for a run with screenshots", async () => {
  const runDir = await fixtureRunDir();
  const steps = [{ index: 1, title: "launch", status: "finished" as const, summary: "", screenshots: ["assets/screenshots/a.png"] }];
  const b64 = await buildEvidenceCardPng({ runDir, run, steps });
  assert.ok(b64 && b64.length > 100);
  const meta = await sharp(Buffer.from(b64!, "base64")).metadata();
  assert.equal(meta.format, "png");
});

test("returns null when no step has a screenshot", async () => {
  const runDir = await fixtureRunDir();
  const b64 = await buildEvidenceCardPng({ runDir, run, steps: [{ index: 1, title: "x", status: "finished" as const, summary: "", screenshots: [] }] });
  assert.equal(b64, null);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test -- --test-name-pattern="returns a base64 PNG|returns null when no step"`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/mcp/live/evidenceCard.ts`**

```typescript
import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { EvidenceRun } from "../types.js";
import type { TimelineStep } from "./dumpTimeline.js";

const FRAME_W = 90, FRAME_H = 160, GAP = 8, PAD = 14, BAND_H = 64, CAP_H = 22, MAX_FRAMES = 5;

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
}
function sampleEven(len: number, max: number): number[] {
  const n = Math.min(max, len);
  if (n <= 1) return [0];
  return Array.from({ length: n }, (_, i) => Math.round((i * (len - 1)) / (n - 1)));
}

export async function buildEvidenceCardPng(input: { runDir: string; run: EvidenceRun; steps: TimelineStep[] }): Promise<string | null> {
  const { runDir, run, steps } = input;
  const pass = run.status === "SUCCESS";
  const shots = steps.filter((s) => s.screenshots.length > 0);
  if (!shots.length) return null;
  const failed = steps.find((s) => s.status === "failed" && s.screenshots.length > 0);
  const decisive = pass ? shots[shots.length - 1] : (failed ?? shots[shots.length - 1]);
  const picked = sampleEven(shots.length, MAX_FRAMES).map((i) => shots[i]!);
  if (!picked.includes(decisive)) picked[picked.length - 1] = decisive;

  const loaded = (await Promise.all(picked.map(async (s) => {
    const rel = s.screenshots[s.screenshots.length - 1]!;
    const abs = join(runDir, rel);
    if (!existsSync(abs)) return null;
    const buf = await sharp(abs).resize(FRAME_W, FRAME_H, { fit: "cover" }).png().toBuffer();
    return { step: s, b64: buf.toString("base64"), decisive: s === decisive };
  }))).filter(Boolean) as { step: TimelineStep; b64: string; decisive: boolean }[];
  if (!loaded.length) return null;

  const width = PAD * 2 + loaded.length * FRAME_W + (loaded.length - 1) * GAP;
  const height = BAND_H + PAD + FRAME_H + CAP_H + PAD;
  const verdict = pass ? "PASS" : "FAIL";
  const meta = `${pass ? `${steps.length}/${steps.length}` : `卡在 ${failed?.index ?? "?"}/${steps.length}`} · ${esc(run.platform ?? "")} ${esc(run.resourceId ?? "")}`;
  const failLine = pass ? "" : `<text x="${PAD}" y="54" fill="#f3b6b6" font-size="12">${esc(run.failureAnalysis.category)} · ${esc(String(run.failureAnalysis.summary).slice(0, 56))}</text>`;
  const frames = loaded.map((f, i) => {
    const x = PAD + i * (FRAME_W + GAP), y = BAND_H + PAD;
    const ring = f.decisive ? `<rect x="${x - 2}" y="${y - 2}" width="${FRAME_W + 4}" height="${FRAME_H + 4}" fill="none" stroke="${pass ? "#46d17f" : "#e5484d"}" stroke-width="3" rx="6"/>` : "";
    return `<image x="${x}" y="${y}" width="${FRAME_W}" height="${FRAME_H}" preserveAspectRatio="xMidYMid slice" href="data:image/png;base64,${f.b64}"/>${ring}`
      + `<text x="${x + FRAME_W / 2}" y="${y + FRAME_H + 14}" fill="#7e8794" font-size="10" text-anchor="middle" font-family="monospace">${f.step.index}</text>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<rect width="100%" height="100%" fill="#0f1115"/>`
    + `<rect width="100%" height="${BAND_H}" fill="${pass ? "#11331f" : "#2a1416"}"/>`
    + `<text x="${PAD}" y="30" fill="${pass ? "#46d17f" : "#ff6b6f"}" font-size="22" font-weight="800" font-family="sans-serif">${verdict}</text>`
    + `<text x="${PAD + 70}" y="29" fill="#cfd4dd" font-size="13" font-family="sans-serif">${esc(String(run.testIntent ?? "").slice(0, 40))}</text>`
    + `<text x="${width - PAD}" y="29" fill="${pass ? "#9be8b8" : "#f3b6b6"}" font-size="12" text-anchor="end" font-family="monospace">${meta}</text>`
    + failLine + frames + `</svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return png.toString("base64");
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- --test-name-pattern="returns a base64 PNG|returns null when no step"`
Expected: PASS.

- [ ] **Step 5: Integrate into writeEvidence**

In `src/mcp/evidence.ts`: import `buildEvidenceCardPng`, extend `WriteEvidenceResult` with `cardPngBase64?: string`, and after writing the HTML compute the card (never throw):
```typescript
  let cardPngBase64: string | undefined;
  try {
    cardPngBase64 = (await buildEvidenceCardPng({ runDir, run: input.run, steps: assets.steps })) ?? undefined;
  } catch { cardPngBase64 = undefined; }
  return { runDir, evidencePath, metadataPath, cardPngBase64 };
```
Update the `evidence.test.ts` expectation (Task 5) to allow the extra field (it already only asserts the known fields).

- [ ] **Step 6: Tests + type check + commit**

Run: `npm test` (all pass), `npm run check`.
```bash
git add src/mcp/live/evidenceCard.ts src/mcp/evidence.ts src/tests/evidenceCard.test.ts
git commit -m "feat(evidence): generate inline composite verdict card via sharp"
```

---

## Task 9: save_report returns image + resource_link inline

**Files:**
- Create: `src/mcp/live/saveReportContent.ts`
- Modify: `src/mcp/server.ts` (`save_report` handler)
- Test: `src/tests/saveReportContent.test.ts`

- [ ] **Step 1: Write the failing test**

`src/tests/saveReportContent.test.ts`:
```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSaveReportContent } from "../mcp/live/saveReportContent.ts";

test("with card: text + image + resource_link(file://, text/html)", () => {
  const c = buildSaveReportContent({ summaryText: "PASS 8/8", evidencePath: "/tmp/run/evidence.html", cardPngBase64: "AAAA" });
  assert.equal(c[0].type, "text");
  assert.ok(c.some((x) => x.type === "image" && x.mimeType === "image/png"));
  const link = c.find((x) => x.type === "resource_link");
  assert.ok(link && link.uri === "file:///tmp/run/evidence.html" && link.mimeType === "text/html");
});

test("without card: text + resource_link only", () => {
  const c = buildSaveReportContent({ summaryText: "x", evidencePath: "/tmp/run/evidence.html", cardPngBase64: undefined });
  assert.equal(c.length, 2);
  assert.ok(!c.some((x) => x.type === "image"));
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test -- --test-name-pattern="with card:|without card:"`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/mcp/live/saveReportContent.ts`**

```typescript
type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; mimeType: string; name: string };

export function buildSaveReportContent(input: { summaryText: string; evidencePath: string; cardPngBase64?: string }): Content[] {
  const out: Content[] = [{ type: "text", text: input.summaryText }];
  if (input.cardPngBase64) out.push({ type: "image", data: input.cardPngBase64, mimeType: "image/png" });
  const uri = input.evidencePath.startsWith("file://") ? input.evidencePath : `file://${input.evidencePath}`;
  out.push({ type: "resource_link", uri, mimeType: "text/html", name: "evidence.html" });
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- --test-name-pattern="with card:|without card:"`
Expected: PASS.

- [ ] **Step 5: Wire save_report in `server.ts`**

In the `save_report` handler, replace the `return jsonResult(await writeEvidence(...))` with:
```typescript
      const evidence = await writeEvidence({ outputRoot: preflightHome, run: { ...run, status: summary.status, failureAnalysis: summary.failureAnalysis, reportDir: run.reportDir } });
      const summaryText = JSON.stringify({ status: summary.status, evidencePath: evidence.evidencePath, failureAnalysis: summary.failureAnalysis }, null, 2);
      return { content: buildSaveReportContent({ summaryText, evidencePath: evidence.evidencePath, cardPngBase64: evidence.cardPngBase64 }) };
```
Add `import { buildSaveReportContent } from "./live/saveReportContent.js";`.

- [ ] **Step 6: Tests + type check + commit**

Run: `npm test` (all), `npm run check`. Manually: run a flow + `save_report`, confirm the chat shows the verdict card inline + an `evidence.html` link that opens the report.
```bash
git add src/mcp/live/saveReportContent.ts src/mcp/server.ts src/tests/saveReportContent.test.ts
git commit -m "feat(evidence): return inline verdict card + evidence.html link from save_report"
```

---

## Task 10: Android-emulator end-to-end verification (live viewer + evidence + inline card)

Final acceptance gate. Drives Preflight's own MCP tools against a booted Android emulator and verifies the new live viewer (during the run), the evidence folder, and the inline card together, in one real run. This is a verification task, not TDD; it runs the real stack. Run it only after Tasks 1-9 and the live-viewer dependency are in place.

Note for the executing agent: the curl checks, the inline card (returned to you in the `save_report` result, so you can view it), and the `evidence.html` greps are the automatable core. The browser eyeball points are human-in-the-loop; surface the `liveUrl` and `evidence.html` path for the user and report what you verified programmatically.

- [ ] **Step 1: Boot an Android emulator**

REQUIRED SUB-SKILL: invoke `android-emulator-setup` to install the SDK command-line tools, create an AVD, and boot it (skip any parts already present).
Run: `adb devices`
Expected: a line like `emulator-5554   device` (online). If `scrcpy` or `ffmpeg` is missing, `brew install scrcpy ffmpeg` (ffmpeg is bundled via `@ffmpeg-installer`; scrcpy is needed only for the evidence recording video. Without scrcpy the live stream still works via `adb screenrecord`, and the evidence no-video fallback is exercised, which is also a valid check).

- [ ] **Step 2: Agent health + device**

Via the MCP tools: `doctor` (expect adb OK and the agent reachable), then `list_devices` and note the emulator resourceId (e.g., `android:emulator-5554`).

- [ ] **Step 3: Define a tiny representative visualFlow**

Cold-start compliant (every visualFlow begins with closeApp + launch). Target the always-present Settings app:
```json
{ "steps": [
  { "type": "closeApp", "packageName": "com.android.settings" },
  { "type": "launch", "packageName": "com.android.settings" },
  { "type": "sleep", "ms": 2000 },
  { "type": "aiTap", "prompt": "顶部搜索入口 (Search settings)" },
  { "type": "sleep", "ms": 1500 },
  { "type": "assert", "prompt": "当前处于设置搜索界面" }
] }
```
Adjust prompts to the emulator's Settings UI and locale.

- [ ] **Step 4: Start the run**

Call `run_flow` with `platform: "ANDROID"`, the emulator resourceId, the visualFlow, a `testIntent`, and `waitForCompletion: false`. Capture `runId` and `liveUrl`.

- [ ] **Step 5: Verify the LIVE viewer while running (programmatic)**

With `RUN=<runId>` and `BASE=<liveUrl origin>`:
```bash
curl -s "$BASE/runs/$RUN/live" | grep -qE 'id="timeline"|id="device"' && echo OK-page
curl -s --max-time 6 "$BASE/runs/$RUN/screen.mjpeg" | head -c 4000 | xxd | grep -qi 'ffd8' && echo OK-stream
curl -s "$BASE/runs/$RUN/dump" | grep -q '"steps"' && echo OK-dump
curl -s --max-time 4 -N "$BASE/runs/$RUN/events" | grep -m1 -E 'data:.*(status|bundleId|revision)' && echo OK-sse
```
Expected: `OK-page`, `OK-stream`, `OK-dump`, `OK-sse`. Then open `liveUrl` in a browser and eyeball: live smooth stream, no black bar at varied window heights, status bar shows bundleId `com.android.settings`, timeline auto-follows the current step, and the run does NOT stall (stream is non-disruptive).

- [ ] **Step 6: Drive to completion**

Poll `watch_run` (without `waitForCompletion`) until status is SUCCESS / FAILED / CANCELLED.

- [ ] **Step 7: Verify EVIDENCE + inline card**

Call `save_report`. Assert the result `content` array includes: a `text` block (verdict), an `image` block with `mimeType: "image/png"` (the inline card; view it and confirm it shows the verdict + key frames), and a `resource_link` whose uri is `file://...evidence.html`. Then on disk:
```bash
RUNDIR=~/.preflight/self-test-runs/$RUN
test -f "$RUNDIR/evidence.html" && echo OK-html
ls "$RUNDIR/assets/screenshots" >/dev/null 2>&1 && echo OK-assets
test -f "$RUNDIR/metadata.json" && echo OK-meta
test ! -f "$RUNDIR/evidence.md" && echo OK-no-md
grep -qiE 'PASS|FAIL' "$RUNDIR/evidence.html" && echo OK-verdict
```
Open `evidence.html`: verdict correct, per-step screenshots load from `assets/`, video plays (or the no-video fallback shows the last/error screenshot if scrcpy was absent), details collapsed. Move `$RUNDIR` elsewhere and reopen to confirm portability.

- [ ] **Step 8: Acceptance checklist**

Confirm all: live stream renders and is non-disruptive on the emulator; bundleId shown and updates; per-step screenshots in the timeline; SSE updates without a full reload; `evidence.html` self-contained and portable; inline card returned from `save_report` (image + link). Record any gaps as follow-up fixes against the relevant task (2-9) and re-run this task after fixing. No commit of its own.

---

## Self-Review (completed during authoring)

- **Spec coverage:** HTML replaces md (Task 5), portable assets/ folder (Task 3), two-pane reuse + verdict + failure banner + video (Task 4), reuse of timeline builders (Task 1) and dumpTimeline (Tasks 3-5), no-video fallback + edges (Task 6), metadata.json kept (Task 5), inline composite card + image/resource_link from save_report, Section 11 (Tasks 8-9), Android-emulator end-to-end acceptance of live viewer + evidence + card (Task 10), dependency on live-viewer modules (Task 1 + Dependency section). All spec sections map to a task.
- **Placeholder scan:** the non-code steps are the verifications (Task 7 manual checks, Task 10 emulator acceptance), both with explicit commands/criteria. No TBD/TODO.
- **Type consistency:** `TimelineStep`/`TimelineView` reused from `dumpTimeline.ts`; `stepCollapsedHTML`/`stepExpandedHTML`/`EVIDENCE_CSS` from `timelineMarkup.ts` consistent across Tasks 1,4,6; `copyRunAssets` -> `{ steps, recordingRel }` consumed identically in Task 5; `renderEvidenceHTML({ run, steps, recordingRel })` consistent across Tasks 4,5,6; `writeEvidence` returns `{ runDir, evidencePath, metadataPath }` (unchanged shape, evidencePath now .html).

## Risks

- Cross-plan dependency: must execute after the live-viewer plan is merged (Task 1 Step 1 gate).
- `EVIDENCE_CSS` scope: the shared CSS must cover both live and evidence selectors without one overriding the other; keep evidence-only rules (`.verdict`, `.failure-banner`, `.media video`) namespaced under `.evidence`.
- Recording resolution by newest mtime assumes one recording per run; if multiple, newest wins (documented).
- Inline card token cost: the base64 PNG is added to the agent's context on every `save_report`. Keep frames small (cover-cropped to 90x160) and capped at 5; if still heavy, lower frame count or JPEG-encode. `resource_link` rendering is client-dependent (reference, not inline HTML); the inline `image` is the reliable surface.
