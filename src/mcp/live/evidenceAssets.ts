import { mkdir, copyFile, readdir, stat } from "node:fs/promises";
import { join, basename, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import type { TimelineStep } from "./dumpTimeline.js";

export interface CopyAssetsInput { reportDir: string; runDir: string; steps: TimelineStep[]; }
export interface CopyAssetsResult { steps: TimelineStep[]; recordingRel?: string; }

export async function copyRunAssets(input: CopyAssetsInput): Promise<CopyAssetsResult> {
  const shotsOut = join(input.runDir, "assets", "screenshots");
  await mkdir(shotsOut, { recursive: true });
  const seen = new Map<string, string>(); // rel -> assets rel
  for (const step of input.steps) {
    for (const rel of step.screenshots) {
      if (seen.has(rel)) continue;
      const name = basename(rel);
      // Defense-in-depth: rel is caller-supplied; never read outside reportDir.
      // Still record the rewrite (unconditional contract) — just skip the copy.
      const src = resolve(input.reportDir, rel);
      const root = resolve(input.reportDir);
      if (src !== root && !src.startsWith(root + sep)) { seen.set(rel, `assets/screenshots/${name}`); continue; }
      if (existsSync(src)) await copyFile(src, join(shotsOut, name)).catch(() => {});
      seen.set(rel, `assets/screenshots/${name}`);
    }
  }
  const steps = input.steps.map((s) => ({ ...s, screenshots: s.screenshots.map((r) => seen.get(r) ?? r) }));

  // recording: newest mp4 under <reportDir>/recordings/
  let recordingRel: string | undefined;
  const recDir = join(input.reportDir, "recordings");
  if (existsSync(recDir)) {
    const mp4s = (await readdir(recDir)).filter((f) => f.endsWith(".mp4"));
    if (mp4s.length) {
      const withTime = await Promise.all(mp4s.map(async (f) => ({ f, t: (await stat(join(recDir, f))).mtimeMs })));
      const newest = withTime.sort((a, b) => b.t - a.t)[0]!.f;
      await copyFile(join(recDir, newest), join(input.runDir, "assets", "recording.mp4")).catch(() => {});
      if (existsSync(join(input.runDir, "assets", "recording.mp4"))) recordingRel = "assets/recording.mp4";
    }
  }
  return { steps, recordingRel };
}
