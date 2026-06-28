/**
 * Static evidence.html renderer (no SSE, no stream, no polling).
 *
 * Produces a complete self-contained document: a PASS/FAIL verdict bar, an
 * optional failure banner, a left media pane (recorded video, aspect-fit to the
 * page height like the live viewer), and a right step-timeline built from the
 * same shared markup builders the live page uses. Screenshot and recording URLs
 * are relative `assets/...` paths (rewritten by copyRunAssets) — never absolute,
 * never network — so the page works offline straight off disk.
 *
 * Free-variable split mirrors page.ts: GLYPH and dataHTML are INJECTED here (a
 * GLYPH const + dataHTML.toString()), so the injected builder bodies reference
 * those definitions; esc and escAttr are NOT injected — the client script below
 * defines its own, kept behaviorally identical to timelineMarkup's. Add a new
 * builder free variable only by injecting it here or defining it identically.
 */
import type { AgentArtifact, EvidenceRun } from "../types.js";
import type { TimelineStep } from "./dumpTimeline.js";
import { stepCollapsedHTML, stepExpandedHTML, dataHTML, GLYPH, esc, escAttr, EVIDENCE_CSS } from "./timelineMarkup.js";

/**
 * The renderer only reads `run`, so the input accepts a structurally looser
 * shape than `EvidenceRun`: a readonly artifacts list and a plain-string
 * failure category. This keeps callers that build `run` from `as const` literals
 * (e.g. the tests) assignable without casts, while production `EvidenceRun`
 * values still satisfy it.
 */
export interface RenderEvidenceInput {
  run: Omit<EvidenceRun, "artifacts" | "failureAnalysis"> & {
    artifacts: readonly AgentArtifact[];
    failureAnalysis: { category: string; summary: string; recommendation: string };
  };
  steps: TimelineStep[];
  recordingRel?: string;
}

/**
 * Serialize a value for safe inlining inside a `<script>` element. JSON.stringify
 * does NOT escape `<` or the U+2028/U+2029 line separators, so step-derived free
 * text (e.g. `step.error`, which echoes arbitrary app/page text) could contain
 * `</script>` and terminate the element early — an XSS / page-corruption vector.
 * Escaping these to their `\uXXXX` forms is parser-invisible: the JS string still
 * decodes to the identical value at runtime.
 */
function inlineJSON(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** YYYY-MM-DD from an ISO timestamp; empty string if unparseable. */
function fmtDate(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "";
}

/** Wall-clock duration between two ISO timestamps as MM:SS (clamped at 0). */
function fmtDuration(createdAt: string, updatedAt: string): string {
  const ms = Date.parse(updatedAt) - Date.parse(createdAt);
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/** Index of the decisive step: the first failed step, else the last step. */
function decisiveIndex(steps: TimelineStep[]): number | undefined {
  const failed = steps.find((s) => s.status === "failed");
  if (failed) return failed.index;
  return steps.length ? steps[steps.length - 1].index : undefined;
}

export function renderEvidenceHTML(input: RenderEvidenceInput): string {
  const { run, steps, recordingRel } = input;
  const pass = run.status === "SUCCESS";
  const verdict = pass ? "PASS" : "FAIL";
  const duration = fmtDuration(run.createdAt, run.updatedAt);
  const failed = steps.find((s) => s.status === "failed");
  const sel = decisiveIndex(steps);
  const progress = pass
    ? `${steps.length}/${steps.length}`
    : `卡在 ${failed ? failed.index : steps.length}/${steps.length}`;

  // §4.1 meta tail: platform, device, appRef, and date.
  const deviceLabel = [run.platform, run.resourceId, run.appRef].filter(Boolean).join(" · ");
  const date = fmtDate(run.createdAt);

  // ── Verdict bar ───────────────────────────────────────────────
  const verdictBar =
    `<div class="verdict">`
    + `<span class="big">${verdict}</span>`
    + (run.testIntent ? `<span class="intent">${esc(run.testIntent)}</span>` : "")
    + `<span class="tail">`
    + (deviceLabel ? `<span class="meta">${esc(deviceLabel)}</span>` : "")
    + (date ? `<span class="meta"><span class="v">${esc(date)}</span></span>` : "")
    + `<span class="meta">步骤 <span class="v">${esc(progress)}</span></span>`
    + `<span class="meta">耗时 <span class="v">${esc(duration)}</span></span>`
    + `</span></div>`;

  // ── Failure banner (FAIL only) ────────────────────────────────
  const fa = run.failureAnalysis;
  // `failure-banner` is the spec-mandated class (and what the test asserts on);
  // `fbanner` is the CSS styling hook — EVIDENCE_CSS must not contain the literal
  // "failure-banner" or it would leak onto PASS pages (which carry no banner).
  const banner = pass
    ? ""
    : `<div class="failure-banner fbanner"><span class="cat">${esc(fa.category)}</span> ${esc(fa.summary)}`
      + `<div class="rec"><span class="lbl">建议</span> ${esc(fa.recommendation)}</div></div>`;

  // ── Left media pane ───────────────────────────────────────────
  // Fallback priority: (a) failed step's last screenshot, (b) last step's last
  // screenshot (scanning from end), (c) 无画面 placeholder.
  const fallbackShot = (() => {
    const failedStep = steps.find((s) => s.status === "failed" && (s.screenshots ?? []).length > 0);
    if (failedStep) return failedStep.screenshots[failedStep.screenshots.length - 1];
    for (let i = steps.length - 1; i >= 0; i--) {
      const shots = steps[i].screenshots ?? [];
      if (shots.length > 0) return shots[shots.length - 1];
    }
    return undefined;
  })();

  const hasMedia = recordingRel || fallbackShot;
  const media = recordingRel
    ? `<video id="recording" src="${escAttr(recordingRel)}" controls playsinline preload="metadata"></video>`
    : fallbackShot
      ? `<img class="media-shot" src="${escAttr(fallbackShot)}" alt="screenshot" onerror="this.style.display='none'">`
      : `<div class="novideo">无画面</div>`;

  // ── Right timeline (server-rendered: decisive step expanded) ──
  const timeline = steps
    .map((s) => (s.index === sel ? stepExpandedHTML(s) : stepCollapsedHTML(s)))
    .join("");

  // ── Bottom: artifacts + script/visualFlow details ─────────────
  // §4.5: portable tiles pointing into the self-contained assets/ folder, not the
  // remote artifact URIs (which break when the <runId>/ folder is moved). Only the
  // HTML-report tile is allowed to point at the original/remote report.
  const tile = (href: string, k: string, v: string) =>
    `<a class="tile" href="${escAttr(href)}" target="_blank" rel="noreferrer">`
    + `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></a>`;
  const shotCount = new Set(steps.flatMap((s) => s.screenshots ?? [])).size;
  const reportArtifact = run.artifacts.find((a) => /report|html/i.test(a.type));
  const artifactTiles =
    (recordingRel ? tile(recordingRel, "录屏", "recording.mp4") : "")
    + (shotCount > 0 ? tile("assets/screenshots/", "截图", `${shotCount} 张`) : "")
    + (reportArtifact ? tile(reportArtifact.uri, "report.html", "原始报告") : "");
  let visualFlowStr: string;
  try {
    visualFlowStr = JSON.stringify(run.visualFlow, null, 2) ?? "";
  } catch {
    visualFlowStr = "";
  }
  const bottom =
    `<div class="bottom">`
    + (artifactTiles ? `<div class="artifacts">${artifactTiles}</div>` : "")
    + `<details><summary>详情（脚本 / visualFlow）</summary>`
    + `<pre>${esc(run.script ?? "")}</pre>`
    + `<pre>${esc(visualFlowStr)}</pre>`
    + `</details></div>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Evidence ${esc(run.runId)}</title>
  <style>${EVIDENCE_CSS}</style>
</head>
<body class="evidence ${pass ? "pass" : "fail"}">
  ${verdictBar}
  ${banner}
  <div class="body${hasMedia ? "" : " no-media"}">
    <div id="device" class="media">${media}</div>
    <div id="timeline">${timeline}</div>
  </div>
  ${bottom}
  <script>
    // Shared step-markup builders, injected verbatim from timelineMarkup.ts so the
    // evidence page and the live page render steps identically. GLYPH and dataHTML
    // are injected; esc and escAttr are defined locally (identical to the module's)
    // because the injected builder bodies reference them as free identifiers.
    const STEPS = ${inlineJSON(steps)};
    let sel = ${JSON.stringify(sel ?? null)};
    const GLYPH = ${JSON.stringify(GLYPH)};
    function esc(s) { return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
    function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }
    ${dataHTML.toString()}
    ${stepCollapsedHTML.toString()}
    ${stepExpandedHTML.toString()}
    function renderTimeline(selIndex) {
      const root = document.getElementById('timeline');
      root.innerHTML = STEPS.map(s => s.index === selIndex ? stepExpandedHTML(s) : stepCollapsedHTML(s)).join('');
    }
    document.getElementById('timeline').addEventListener('click', (e) => {
      const row = e.target.closest && e.target.closest('[data-step]');
      if (!row) return;
      if (e.target.closest && e.target.closest('.strip')) return;  // clicking screenshots shouldn't collapse the card
      const idx = Number(row.dataset.step);
      sel = (sel === idx) ? null : idx;   // re-click the open step to collapse it
      renderTimeline(sel);
    });

    // ── Aspect-fit sizing (mirrors the live page's syncDeviceWidth) ──
    const video = document.getElementById('recording');
    const img = document.querySelector('.media-shot');
    const device = document.getElementById('device');
    function syncDeviceWidth() {
      if (video && video.videoWidth && video.videoHeight) {
        device.style.width = (device.clientHeight * video.videoWidth / video.videoHeight) + 'px';
      } else if (img && img.naturalWidth && img.naturalHeight) {
        device.style.width = (device.clientHeight * img.naturalWidth / img.naturalHeight) + 'px';
      }
    }
    if (video) {
      video.addEventListener('loadedmetadata', syncDeviceWidth);
      window.addEventListener('resize', syncDeviceWidth);
    } else if (img) {
      img.addEventListener('load', syncDeviceWidth);
      window.addEventListener('resize', syncDeviceWidth);
    }
  </script>
</body>
</html>`;
}
