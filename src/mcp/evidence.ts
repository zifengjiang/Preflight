import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EvidenceRun } from "./types.js";
import { buildTimelineFromReportDir, mergeWithVisualFlow, type TimelineView, type TimelineStep } from "./live/dumpTimeline.js";
import { copyRunAssets } from "./live/evidenceAssets.js";
import { renderEvidenceHTML } from "./live/evidencePage.js";
import { buildEvidenceCardPng } from "./live/evidenceCard.js";

export interface WriteEvidenceInput {
  run: EvidenceRun;
  outputRoot?: string;
}

export interface WriteEvidenceResult {
  runDir: string;
  evidencePath: string;
  metadataPath: string;
  cardPngBase64?: string;
}

export async function writeEvidence(input: WriteEvidenceInput): Promise<WriteEvidenceResult> {
  const runDir = join(input.outputRoot ?? join(homedir(), ".preflight"), "self-test-runs", input.run.runId);
  await mkdir(runDir, { recursive: true });
  const evidencePath = join(runDir, "evidence.html");
  const metadataPath = join(runDir, "metadata.json");

  let view: TimelineView;
  let assets: { steps: TimelineStep[]; recordingRel?: string };
  if (input.run.reportDir) {
    try {
      view = mergeWithVisualFlow(await buildTimelineFromReportDir(input.run.reportDir), input.run.visualFlow);
    } catch {
      view = { revision: 0, steps: [] };
    }
    try {
      assets = await copyRunAssets({ reportDir: input.run.reportDir, runDir, steps: view.steps });
    } catch {
      assets = { steps: view.steps, recordingRel: undefined };
    }
  } else {
    view = { revision: 0, steps: [] };
    assets = { steps: [], recordingRel: undefined };
  }

  await writeFile(evidencePath, renderEvidenceHTML({ run: input.run, steps: assets.steps, recordingRel: assets.recordingRel }), "utf8");
  await writeFile(metadataPath, JSON.stringify(input.run, null, 2), "utf8");

  let cardPngBase64: string | undefined;
  try {
    cardPngBase64 = (await buildEvidenceCardPng({ runDir, run: input.run, steps: assets.steps })) ?? undefined;
  } catch { cardPngBase64 = undefined; }
  return { runDir, evidencePath, metadataPath, cardPngBase64 };
}
