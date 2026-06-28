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
