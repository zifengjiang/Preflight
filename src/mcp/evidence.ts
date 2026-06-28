import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EvidenceRun } from "./types.js";
import { buildTimelineFromReportDir, mergeWithVisualFlow } from "./live/dumpTimeline.js";
import { copyRunAssets } from "./live/evidenceAssets.js";
import { renderEvidenceHTML } from "./live/evidencePage.js";

export interface WriteEvidenceInput {
  run: EvidenceRun;
  outputRoot?: string;
}

export interface WriteEvidenceResult {
  runDir: string;
  evidencePath: string;
  metadataPath: string;
}

export async function writeEvidence(input: WriteEvidenceInput): Promise<WriteEvidenceResult> {
  const runDir = join(input.outputRoot ?? join(homedir(), ".preflight"), "self-test-runs", input.run.runId);
  await mkdir(runDir, { recursive: true });
  const evidencePath = join(runDir, "evidence.html");
  const metadataPath = join(runDir, "metadata.json");

  const view = input.run.reportDir
    ? mergeWithVisualFlow(await buildTimelineFromReportDir(input.run.reportDir), input.run.visualFlow)
    : { revision: 0, steps: [] };
  const assets = input.run.reportDir
    ? await copyRunAssets({ reportDir: input.run.reportDir, runDir, steps: view.steps })
    : { steps: view.steps, recordingRel: undefined };

  await writeFile(evidencePath, renderEvidenceHTML({ run: input.run, steps: assets.steps, recordingRel: assets.recordingRel }), "utf8");
  await writeFile(metadataPath, JSON.stringify(input.run, null, 2), "utf8");

  return { runDir, evidencePath, metadataPath };
}
