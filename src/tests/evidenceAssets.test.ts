import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, readFile, utimes, access } from "node:fs/promises";
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
  const copied = (await readdir(join(runDir, "assets", "screenshots"))).sort();
  assert.deepEqual(copied, ["a.png"]); // deduped
  assert.equal(out.steps[0].screenshots[0], "assets/screenshots/a.png"); // rewritten
});

test("copies the newest recording mp4 into assets/recording.mp4", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-rec-"));
  const reportDir = join(root, "report");
  const recDir = join(reportDir, "recordings");
  await mkdir(recDir, { recursive: true });
  const runDir = join(root, "run");
  await mkdir(runDir, { recursive: true });

  // Two mp4s with distinct mtimes; "new.mp4" is forced to be the newest.
  await writeFile(join(recDir, "old.mp4"), "OLD");
  await writeFile(join(recDir, "new.mp4"), "NEW");
  await utimes(join(recDir, "old.mp4"), new Date(1000), new Date(1000));
  await utimes(join(recDir, "new.mp4"), new Date(2000), new Date(2000));

  const out = await copyRunAssets({ reportDir, runDir, steps: [] });

  assert.equal(out.recordingRel, "assets/recording.mp4");
  const dest = join(runDir, "assets", "recording.mp4");
  await assert.doesNotReject(access(dest)); // dest exists
  // Content matches the NEWEST source — verifies newest-by-mtime selection.
  assert.equal(await readFile(dest, "utf8"), "NEW");
});
