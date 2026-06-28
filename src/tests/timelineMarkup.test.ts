import { test } from "node:test";
import assert from "node:assert/strict";
import { stepCollapsedHTML, stepExpandedHTML, dataHTML, esc, escAttr } from "../mcp/live/timelineMarkup.ts";

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
test("dataHTML returns '' for empty-sentinel values", () => {
  for (const v of ["{}", "[]", "null", ""]) assert.equal(dataHTML(v), "");
});
test("dataHTML truncates >400-char input with an ellipsis", () => {
  const html = dataHTML("x".repeat(500));
  assert.match(html, /…/);
  assert.equal(html.includes("x".repeat(401)), false);
  assert.equal(html.includes("x".repeat(400)), true);
});
test("esc escapes &, <, >", () => {
  assert.equal(esc("<b>&"), "&lt;b&gt;&amp;");
});
test("escAttr escapes the double-quote too", () => {
  assert.equal(escAttr('a"b'), "a&quot;b");
});
