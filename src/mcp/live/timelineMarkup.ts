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
