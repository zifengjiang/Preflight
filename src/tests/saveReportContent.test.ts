import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSaveReportContent, type Content } from "../mcp/live/saveReportContent.ts";

test("with card: text + image + resource_link(file://, text/html)", () => {
  const c = buildSaveReportContent({ summaryText: "PASS 8/8", evidencePath: "/tmp/run/evidence.html", cardPngBase64: "AAAA" });
  assert.equal(c[0].type, "text");
  assert.ok(c.some((x) => x.type === "image" && x.mimeType === "image/png"));
  const link = c.find((x): x is Extract<Content, { type: "resource_link" }> => x.type === "resource_link");
  assert.ok(link && link.uri === "file:///tmp/run/evidence.html" && link.mimeType === "text/html");
});

test("without card: text + resource_link only", () => {
  const c = buildSaveReportContent({ summaryText: "x", evidencePath: "/tmp/run/evidence.html", cardPngBase64: undefined });
  assert.equal(c.length, 2);
  assert.ok(!c.some((x) => x.type === "image"));
});
