import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEvidenceCardPng } from "../mcp/live/evidenceCard.ts";

const run = {
  runId: "r1", taskId: "t1", status: "SUCCESS", platform: "ANDROID", resourceId: "pixel-7",
  appRef: "com.demo", testIntent: "打开设置", createdAt: "2026-06-27T14:00:00Z", updatedAt: "2026-06-27T14:02:00Z",
  liveUrl: "", artifacts: [], failureAnalysis: { category: "none", summary: "", recommendation: "" },
} as const;

async function fixtureRunDir() {
  const runDir = await mkdtemp(join(tmpdir(), "card-"));
  await mkdir(join(runDir, "assets", "screenshots"), { recursive: true });
  const png = await sharp({ create: { width: 9, height: 16, channels: 3, background: "#123456" } }).png().toBuffer();
  await writeFile(join(runDir, "assets", "screenshots", "a.png"), png);
  return runDir;
}

test("returns a base64 PNG for a run with screenshots", async () => {
  const runDir = await fixtureRunDir();
  const steps = [{ index: 1, title: "launch", status: "finished" as const, summary: "", screenshots: ["assets/screenshots/a.png"] }];
  const b64 = await buildEvidenceCardPng({ runDir, run, steps });
  assert.ok(b64 && b64.length > 100);
  const meta = await sharp(Buffer.from(b64!, "base64")).metadata();
  assert.equal(meta.format, "png");
});

test("returns null when no step has a screenshot", async () => {
  const runDir = await fixtureRunDir();
  const b64 = await buildEvidenceCardPng({ runDir, run, steps: [{ index: 1, title: "x", status: "finished" as const, summary: "", screenshots: [] }] });
  assert.equal(b64, null);
});
