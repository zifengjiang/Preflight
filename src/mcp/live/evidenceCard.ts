import sharp from "sharp";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { AgentArtifact, EvidenceRun } from "../types.js";
import type { TimelineStep } from "./dumpTimeline.js";

const FRAME_W = 90, FRAME_H = 160, GAP = 8, PAD = 14, BAND_H = 64, CAP_H = 22, MAX_FRAMES = 5;

/**
 * Structurally widened run type so `as const` test literals are assignable
 * (readonly artifacts, narrow category string) while production EvidenceRun
 * values still satisfy it. Mirrors the pattern in RenderEvidenceInput.
 */
type CardRun = Omit<EvidenceRun, "artifacts" | "failureAnalysis"> & {
  artifacts: readonly AgentArtifact[];
  failureAnalysis: { category: string; summary: string; recommendation: string };
};

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
}
function sampleEven(len: number, max: number): number[] {
  const n = Math.min(max, len);
  if (n <= 1) return [0];
  return Array.from({ length: n }, (_, i) => Math.round((i * (len - 1)) / (n - 1)));
}

export async function buildEvidenceCardPng(input: { runDir: string; run: CardRun; steps: TimelineStep[] }): Promise<string | null> {
  const { runDir, run, steps } = input;
  const pass = run.status === "SUCCESS";
  const shots = steps.filter((s) => s.screenshots.length > 0);
  if (!shots.length) return null;
  const failed = steps.find((s) => s.status === "failed" && s.screenshots.length > 0);
  const decisive = pass ? shots[shots.length - 1] : (failed ?? shots[shots.length - 1]);
  const picked = sampleEven(shots.length, MAX_FRAMES).map((i) => shots[i]!);
  if (!picked.includes(decisive)) picked[picked.length - 1] = decisive;

  const loaded = (await Promise.all(picked.map(async (s) => {
    const rel = s.screenshots[s.screenshots.length - 1]!;
    const abs = join(runDir, rel);
    if (!existsSync(abs)) return null;
    try {
      const buf = await sharp(abs).resize(FRAME_W, FRAME_H, { fit: "cover" }).png().toBuffer();
      return { step: s, b64: buf.toString("base64"), decisive: s === decisive };
    } catch {
      return null;
    }
  }))).filter(Boolean) as { step: TimelineStep; b64: string; decisive: boolean }[];
  if (!loaded.length) return null;

  const width = PAD * 2 + loaded.length * FRAME_W + (loaded.length - 1) * GAP;
  const height = BAND_H + PAD + FRAME_H + CAP_H + PAD;
  const verdict = pass ? "PASS" : "FAIL";
  const meta = `${pass ? `${steps.length}/${steps.length}` : `卡在 ${failed?.index ?? "?"}/${steps.length}`} · ${esc(run.platform ?? "")} ${esc(run.resourceId ?? "")}`;
  const failLine = pass ? "" : `<text x="${PAD}" y="54" fill="#f3b6b6" font-size="12">${esc(run.failureAnalysis.category)} · ${esc(String(run.failureAnalysis.summary).slice(0, 56))}</text>`;
  const frames = loaded.map((f, i) => {
    const x = PAD + i * (FRAME_W + GAP), y = BAND_H + PAD;
    const ring = f.decisive ? `<rect x="${x - 2}" y="${y - 2}" width="${FRAME_W + 4}" height="${FRAME_H + 4}" fill="none" stroke="${pass ? "#46d17f" : "#e5484d"}" stroke-width="3" rx="6"/>` : "";
    return `<image x="${x}" y="${y}" width="${FRAME_W}" height="${FRAME_H}" preserveAspectRatio="xMidYMid slice" href="data:image/png;base64,${f.b64}"/>${ring}`
      + `<text x="${x + FRAME_W / 2}" y="${y + FRAME_H + 14}" fill="#7e8794" font-size="10" text-anchor="middle" font-family="monospace">${f.step.index}</text>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<rect width="100%" height="100%" fill="#0f1115"/>`
    + `<rect width="100%" height="${BAND_H}" fill="${pass ? "#11331f" : "#2a1416"}"/>`
    + `<text x="${PAD}" y="30" fill="${pass ? "#46d17f" : "#ff6b6f"}" font-size="22" font-weight="800" font-family="sans-serif">${verdict}</text>`
    + `<text x="${PAD + 70}" y="29" fill="#cfd4dd" font-size="13" font-family="sans-serif">${esc(String(run.testIntent ?? "").slice(0, 40))}</text>`
    + `<text x="${width - PAD}" y="29" fill="${pass ? "#9be8b8" : "#f3b6b6"}" font-size="12" text-anchor="end" font-family="monospace">${meta}</text>`
    + failLine + frames + `</svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return png.toString("base64");
}
