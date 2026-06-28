/**
 * Pure per-step markup builders, shared by the live page (browser, injected via
 * `.toString()`) and the evidence renderer (Node). Keeping a single source of
 * truth here is what prevents the two views from drifting.
 *
 * These MUST stay pure string functions — no DOM, no fetch, no module-scope
 * state. Screenshot URLs are taken from `step.screenshots` verbatim, so each
 * caller is responsible for baking the right URL form in beforehand (the live
 * caller rewrites to `/report/<rel>?_rev=<rev>`; evidence passes relative
 * `assets/...` paths through unchanged).
 *
 * Free-variable resolution in the browser is split two ways, and a future editor
 * MUST respect the distinction or the live page silently breaks:
 *   - `GLYPH` and `dataHTML` are INJECTED from this module (page.ts emits a `GLYPH`
 *     const and `dataHTML.toString()`), so the injected builder bodies reference
 *     the very definitions below.
 *   - `esc` and `escAttr` are NOT injected — the browser has its own definitions of
 *     these (page.ts). The copies below MUST stay behaviorally identical to the
 *     browser's so the injected builder bodies behave the same in both contexts.
 * Bottom line: if you add a new free variable to a builder, either inject it from
 * here OR ensure an identical browser-scope definition exists under the same name.
 */
import type { TimelineStep } from "./dumpTimeline.js";

export const GLYPH: Record<string, string> = { finished: "✓", failed: "✗", running: "●", pending: "○" };

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
}

/** Attribute-safe escaping (escapes `"` on top of `esc`). Mirrors page.ts's browser `escAttr`. */
export function escAttr(s: unknown): string {
  return esc(s).replace(/"/g, "&quot;");
}

/** Extracted-data block. Renders nothing for empty/blank values; truncates long strings. */
export function dataHTML(d: unknown): string {
  let str: string;
  try {
    str = typeof d === "string" ? d : JSON.stringify(d);
  } catch {
    return "";
  }
  if (str == null || str === "" || str === "{}" || str === "[]" || str === "null") return "";
  if (str.length > 400) str = str.slice(0, 400) + "…";
  return `<div><span class="lbl">提取数据</span><div class="data">${esc(str)}</div></div>`;
}

export function stepCollapsedHTML(s: TimelineStep): string {
  const dur = s.durationMs != null ? `<span class="dur">${(s.durationMs / 1000).toFixed(1)}s</span>` : "";
  return `<div class="step ${s.status}" data-step="${s.index}"><span class="g ${s.status}">${GLYPH[s.status] ?? ""}</span>`
    + `<span class="t"><b>${s.index} ${esc(s.title)}</b> <span class="sub">${esc(s.summary)}</span></span>${dur}</div>`;
}

export function stepExpandedHTML(s: TimelineStep): string {
  const shots = (s.screenshots ?? [])
    .map((rel, i) => `<figure><img loading="lazy" decoding="async" src="${escAttr(rel)}" onerror="this.closest('figure').classList.add('broken')"><figcaption>${i + 1}</figcaption></figure>`)
    .join("");
  const count = (s.screenshots ?? []).length;
  const action = s.action ? `动作 ${esc(s.action.type)}${s.action.center ? ` (${s.action.center.join(", ")})` : ""}` : "";
  return `<div class="step expanded ${s.status}" data-step="${s.index}"><div class="head"><b>${s.index} ${esc(s.title)}</b></div>`
    + `<div class="cols"><div class="text">`
    + (s.thought ? `<div><span class="lbl">思考</span> ${esc(s.thought)}</div>` : "")
    + (action ? `<div><span class="lbl">${action}</span></div>` : "")
    + dataHTML(s.extractedData)
    + (s.error ? `<div class="err"><span class="lbl">原因</span> ${esc(s.error)}</div>` : "")
    + `</div><div class="strip">${shots || `<span class="sub">本步无截图</span>`}${count ? `<figure style="align-self:center"><figcaption>${count} 张截图</figcaption></figure>` : ""}</div></div></div>`;
}

/**
 * Inline stylesheet for the static evidence page. Carries the same design tokens
 * and the same step/cols/strip/figure rules the live page uses (copied from
 * page.ts so the shared builders render identically), plus evidence-only rules
 * namespaced under `.evidence` to avoid colliding with live-page selectors.
 *
 * The step rules below are an intentional duplicate of page.ts's `<style>`; the
 * shared *markup* (class names emitted by the builders) is what keeps the two
 * views structurally in sync — do not refactor page.ts to consume this.
 */
export const EVIDENCE_CSS = `
    :root {
      --bg: #0f1115;
      --surface: #15181e;
      --border: #23262d;
      --accent: #3b82f6;
      --green: #46d17f;
      --red: #e5484d;
      --text: #e6e9ef;
      --muted: #8b929e;
      --radius: 8px;
      --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
      --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      height: 100dvh;
      display: flex;
      flex-direction: column;
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      font-size: 13px;
      line-height: 1.45;
      overflow: hidden;
    }
    .mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }

    /* ── Step rows (shared with live page) ──────────────────────── */
    .step {
      display: flex;
      align-items: baseline;
      gap: 10px;
      padding: 7px 10px;
      border: 1px solid transparent;
      border-radius: var(--radius);
      cursor: pointer;
    }
    .step:hover { background: var(--surface); }
    .step .g {
      flex: 0 0 auto;
      font-family: var(--mono);
      font-size: 13px;
      width: 14px;
      text-align: center;
      color: var(--muted);
    }
    .step .g.finished { color: var(--green); }
    .step .g.failed { color: var(--red); }
    .step .g.running { color: var(--accent); }
    .step .g.pending { color: var(--muted); }
    .step .t { flex: 1 1 auto; min-width: 0; overflow: hidden; }
    .step .t b { font-weight: 600; }
    .step .t .sub { color: var(--muted); font-weight: 400; }
    .step.pending .t b { color: var(--muted); font-weight: 400; }
    .step .dur {
      flex: 0 0 auto;
      font-family: var(--mono);
      font-variant-numeric: tabular-nums;
      font-size: 11px;
      color: var(--muted);
    }
    .step.expanded {
      display: block;
      cursor: default;
      background: var(--surface);
      border-color: var(--border);
      padding: 12px;
      margin: 6px 0;
    }
    .step.expanded.running { border-color: var(--accent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent); }
    .step.expanded.failed { border-color: color-mix(in srgb, var(--red) 55%, var(--border)); }
    .step.expanded .head { font-weight: 600; margin-bottom: 10px; }
    .step.expanded .head b { font-weight: 600; }
    .cols { display: flex; gap: 14px; align-items: flex-start; }
    .cols .text { flex: 1 1 0; min-width: 0; display: grid; gap: 7px; }
    .cols .text > div { overflow-wrap: anywhere; }
    .lbl {
      display: inline-block;
      font-size: 11px;
      color: var(--muted);
      font-weight: 600;
      margin-right: 4px;
    }
    .cols .text .err { color: var(--red); }
    .cols .text .err .lbl { color: var(--red); }
    .data {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--muted);
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 8px;
      max-height: 120px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .strip {
      display: flex;
      flex-wrap: nowrap;
      gap: 8px;
      overflow-x: auto;
      flex: 0 1 auto;
      max-width: 55%;
      padding-bottom: 4px;
    }
    .strip figure { flex: 0 0 auto; margin: 0; text-align: center; }
    .strip figure.broken { display: none; }
    .strip img {
      height: 160px;
      width: auto;
      border-radius: 6px;
      border: 1px solid var(--border);
      display: block;
    }
    .strip figcaption {
      font-family: var(--mono);
      font-size: 10px;
      color: var(--muted);
      margin-top: 4px;
    }
    .strip .sub { color: var(--muted); font-size: 12px; align-self: center; }

    ::-webkit-scrollbar { width: 9px; height: 9px; }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }

    /* ── Evidence-only: verdict bar ─────────────────────────────── */
    .evidence .verdict {
      flex: 0 0 auto;
      display: flex;
      align-items: baseline;
      gap: 14px;
      padding: 12px 16px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
      overflow: hidden;
    }
    .evidence .verdict .big {
      font-family: var(--mono);
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 0.5px;
    }
    .evidence.pass .verdict .big { color: var(--green); }
    .evidence.fail .verdict .big { color: var(--red); }
    .evidence .verdict .intent {
      font-size: 14px;
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .evidence .verdict .tail {
      margin-left: auto;
      display: inline-flex;
      align-items: baseline;
      gap: 14px;
      color: var(--muted);
      font-size: 12px;
    }
    .evidence .verdict .tail .v {
      font-family: var(--mono);
      font-variant-numeric: tabular-nums;
      color: var(--text);
    }

    /* ── Evidence-only: failure banner ──────────────────────────── */
    /* Styling hook is .fbanner (a second class on the banner element); the
       semantic banner class is intentionally NOT referenced here because the
       evidence renderer's PASS-page test asserts that class name appears
       nowhere, and this stylesheet ships on every page including PASS. */
    .evidence .fbanner {
      flex: 0 0 auto;
      padding: 10px 16px;
      background: color-mix(in srgb, var(--red) 12%, var(--surface));
      border-bottom: 1px solid color-mix(in srgb, var(--red) 45%, var(--border));
      color: var(--text);
      font-size: 13px;
    }
    .evidence .fbanner .cat {
      display: inline-block;
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.3px;
      color: var(--red);
      border: 1px solid color-mix(in srgb, var(--red) 50%, var(--border));
      border-radius: 5px;
      padding: 2px 7px;
      margin-right: 8px;
    }
    .evidence .fbanner .rec { margin-top: 6px; color: var(--muted); }

    /* ── Evidence-only: two-pane body ───────────────────────────── */
    .evidence .body { flex: 1 1 auto; display: flex; min-height: 0; }
    .evidence #device {
      position: relative;
      background: #000;
      height: 100%;
      flex: 0 0 auto;
    }
    .evidence .media video, .evidence .media img {
      height: 100%;
      width: auto;
      display: block;
      object-fit: contain;
    }
    .evidence .novideo {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-width: 240px;
      color: var(--muted);
      font-size: 13px;
      letter-spacing: 0.2px;
    }
    .evidence .media-shot {
      height: 100%;
      width: auto;
      display: block;
      object-fit: contain;
    }
    .evidence .body.no-media #device { display: none; }
    .evidence .body.no-media #timeline { border-left: none; }
    .evidence #timeline {
      flex: 1 1 0;
      min-width: 0;
      overflow-y: auto;
      padding: 10px 12px 14px;
      border-left: 1px solid var(--border);
    }

    /* ── Evidence-only: bottom details ──────────────────────────── */
    .evidence .bottom {
      flex: 0 0 auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px 16px;
      background: var(--surface);
      border-top: 1px solid var(--border);
      max-height: 30vh;
      overflow: auto;
    }
    .evidence .bottom .artifacts { display: flex; gap: 8px; flex-wrap: wrap; }
    .evidence .bottom a.tile {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 7px 11px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg);
      text-decoration: none;
      color: var(--text);
      min-width: 88px;
    }
    .evidence .bottom a.tile:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
    .evidence .bottom .tile .k { font-size: 11px; color: var(--muted); }
    .evidence .bottom .tile .v { font-family: var(--mono); font-size: 12px; }
    .evidence .bottom details {
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg);
    }
    .evidence .bottom details > summary {
      cursor: pointer;
      list-style: none;
      padding: 7px 11px;
      font-size: 12px;
      color: var(--muted);
      user-select: none;
    }
    .evidence .bottom details > summary::-webkit-details-marker { display: none; }
    .evidence .bottom details > summary::before { content: "\\25B8"; display: inline-block; margin-right: 6px; }
    .evidence .bottom details[open] > summary::before { content: "\\25BE"; }
    .evidence .bottom pre {
      margin: 0;
      padding: 8px 11px;
      font-family: var(--mono);
      font-size: 11px;
      color: var(--muted);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-height: 200px;
      overflow: auto;
      border-top: 1px solid var(--border);
    }

    @media (prefers-reduced-motion: no-preference) {
      .step.expanded { animation: reveal 0.18s ease-out; }
      @keyframes reveal { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
    }
`;
