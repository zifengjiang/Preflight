import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildTimelineFromReportDir, mergeWithVisualFlow, resolveActiveReportDir } from "../mcp/live/dumpTimeline.ts";

const fixtureDir = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "report");

test("buildTimelineFromReportDir maps executions to steps in order", async () => {
  const view = await buildTimelineFromReportDir(fixtureDir);
  assert.equal(view.steps.length, 2);
  assert.equal(view.steps[0].title, "Launch");
  assert.equal(view.steps[1].title, "Act - 打开设置");
});

test("aggregates per-step screenshots across tasks in order", async () => {
  const view = await buildTimelineFromReportDir(fixtureDir);
  assert.deepEqual(view.steps[1].screenshots, ["screenshots/b1.png", "screenshots/b2.png"]);
});

test("extracts thought and tap coordinate", async () => {
  const view = await buildTimelineFromReportDir(fixtureDir);
  assert.equal(view.steps[1].thought, "点右上角齿轮");
  assert.deepEqual(view.steps[1].action, { type: "Tap", target: "设置入口", center: [320, 96] });
});

test("mergeWithVisualFlow pads pending steps from visualFlow", async () => {
  const view = await buildTimelineFromReportDir(fixtureDir);
  const visualFlow = {
    steps: [
      { type: "launch", bundleId: "x" },
      { type: "aiTap", prompt: "a" },
      { type: "aiTap", prompt: "b" },
      { type: "aiAssert", prompt: "c" },
    ],
  };
  const merged = mergeWithVisualFlow(view, visualFlow);
  assert.equal(merged.steps.length, 4);
  assert.equal(merged.steps[2].status, "pending");
  assert.equal(merged.steps[3].status, "pending");
});

test("mergeWithVisualFlow overlays running + durationMs from flow-step events", async () => {
  const view = await buildTimelineFromReportDir(fixtureDir);
  // Fixture dump has two finished steps at index 1 and 2.
  assert.equal(view.steps[0].index, 1);
  assert.equal(view.steps[1].index, 2);
  const visualFlow = {
    steps: [
      { type: "launch", bundleId: "x" },
      { type: "aiTap", prompt: "a" },
    ],
  };
  const events = [
    { type: "end" as const, stepIndex: 1, ts: 2, durationMs: 1500 },
    { type: "start" as const, stepIndex: 2, ts: 1 },
  ];
  const merged = mergeWithVisualFlow(view, visualFlow, events);
  const step1 = merged.steps.find((s) => s.index === 1)!;
  const step2 = merged.steps.find((s) => s.index === 2)!;
  // fsv "running" is overlaid onto step 2.
  assert.equal(step2.status, "running");
  // step 1 stays finished (fsv "passed"/end must NOT downgrade the authoritative dump status)
  // but its durationMs is backfilled from the event.
  assert.equal(step1.status, "finished");
  assert.equal(step1.durationMs, 1500);
});

test("resolveActiveReportDir returns fixtureDir itself when no qualifying subdir exists", async () => {
  const result = await resolveActiveReportDir(fixtureDir);
  assert.equal(result, fixtureDir);
});

test("tolerates malformed/empty files and keys screenshots by stepIndex (no misattribution)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "dump-"));
  try {
    const exec = (name: string, shotId: string): string =>
      JSON.stringify({
        executions: [
          {
            name,
            tasks: [
              {
                type: "Action Space",
                subType: "Tap",
                status: "finished",
                uiContext: { screenshot: { type: "midscene_screenshot_ref", id: shotId, mimeType: "image/png" } },
                recorder: [],
              },
            ],
          },
        ],
      });

    writeFileSync(join(tmp, "1.execution.json"), exec("ONE", "s1"));
    writeFileSync(join(tmp, "2.execution.json"), "{ broken json");
    writeFileSync(join(tmp, "3.execution.json"), JSON.stringify({ executions: [] }));
    writeFileSync(join(tmp, "4.execution.json"), exec("THREE", "s3"));

    let view: Awaited<ReturnType<typeof buildTimelineFromReportDir>> | undefined;
    await assert.doesNotReject(async () => {
      view = await buildTimelineFromReportDir(tmp);
    });

    assert.deepEqual(view!.steps.map((s) => s.title), ["ONE", "THREE"]);
    const three = view!.steps.find((s) => s.title === "THREE")!;
    assert.deepEqual(three.screenshots, ["screenshots/s3.png"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
