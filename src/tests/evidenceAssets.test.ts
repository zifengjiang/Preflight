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
