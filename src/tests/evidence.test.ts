import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEvidence } from "../mcp/evidence.ts";

test("writeEvidence emits evidence.html + assets + metadata.json and NOT evidence.md", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-"));
  const reportDir = join(root, "report");
  await mkdir(join(reportDir, "screenshots"), { recursive: true });
  await writeFile(
    join(reportDir, "1.execution.json"),
    JSON.stringify({
      executions: [
        {
          name: "Launch",
          tasks: [
            {
              type: "Action Space",
              subType: "Launch",
              status: "finished",
              uiContext: { screenshot: { type: "midscene_screenshot_ref", id: "a", mimeType: "image/png" } },
              recorder: [],
            },
          ],
        },
      ],
    }),
  );
  await writeFile(join(reportDir, "screenshots", "a.png"), "x");

  const out = await writeEvidence({
    outputRoot: root,
    run: {
      runId: "r1",
      taskId: "t1",
      status: "SUCCESS",
      platform: "ANDROID",
      resourceId: "pixel-7",
      appRef: "com.demo",
      testIntent: "x",
      createdAt: "2026-06-27T14:00:00Z",
      updatedAt: "2026-06-27T14:02:00Z",
      liveUrl: "",
      artifacts: [],
      failureAnalysis: { category: "none", summary: "", recommendation: "" },
      reportDir,
    },
  });

  assert.ok(out.evidencePath.endsWith("evidence.html"));
  const html = await readFile(out.evidencePath, "utf8");
  assert.match(html, /PASS/);
  assert.match(html, /assets\/screenshots\/a\.png/);
  await access(out.metadataPath);
  const files = await readdir(join(root, "self-test-runs", "r1"));
  assert.ok(!files.includes("evidence.md"));
  await rm(root, { recursive: true, force: true });
});

test("writeEvidence still emits evidence.html + metadata.json when run has no reportDir", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-"));

  const out = await writeEvidence({
    outputRoot: root,
    run: {
      runId: "r2",
      taskId: "t2",
      status: "SUCCESS",
      platform: "ANDROID",
      resourceId: "pixel-7",
      appRef: "com.demo",
      testIntent: "x",
      createdAt: "2026-06-27T14:00:00Z",
      updatedAt: "2026-06-27T14:02:00Z",
      liveUrl: "",
      artifacts: [],
      failureAnalysis: { category: "none", summary: "", recommendation: "" },
    },
  });

  assert.ok(out.evidencePath.endsWith("evidence.html"));
  const html = await readFile(out.evidencePath, "utf8");
  assert.match(html, /PASS/);
  await access(out.metadataPath);
  await rm(root, { recursive: true, force: true });
});

test("writeEvidence renders FAIL verdict + failure banner for a non-SUCCESS run", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-"));

  const out = await writeEvidence({
    outputRoot: root,
    run: {
      runId: "r3",
      taskId: "t3",
      status: "FAILED",
      platform: "ANDROID",
      resourceId: "pixel-7",
      appRef: "com.demo",
      testIntent: "x",
      createdAt: "2026-06-27T14:00:00Z",
      updatedAt: "2026-06-27T14:02:00Z",
      liveUrl: "",
      artifacts: [],
      failureAnalysis: { category: "test-or-app-behavior", summary: "x", recommendation: "y" },
    },
  });

  const html = await readFile(out.evidencePath, "utf8");
  assert.match(html, /FAIL/);
  assert.match(html, /failure-banner/);
  await rm(root, { recursive: true, force: true });
});
