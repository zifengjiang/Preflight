import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readReport } from "../reportReader.js";
import { buildFlowStepView } from "../flowStepEvents.js";

// ── Types ────────────────────────────────────────────────────────────

export interface TimelineStep {
  index: number;
  title: string;
  status: "finished" | "failed" | "running" | "pending";
  durationMs?: number;
  summary: string;
  thought?: string;
  action?: { type: string; target?: string; center?: [number, number] };
  extractedData?: unknown;
  error?: string;
  /** screenshot rel paths under the report dir, chronological */
  screenshots: string[];
}

export interface TimelineView {
  revision: number;
  steps: TimelineStep[];
}

// ── Helpers ──────────────────────────────────────────────────────────

interface ScreenshotRef {
  id?: string;
  mimeType?: string;
}

function extFromMime(mimeType?: string): string {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/jpeg") return ".jpeg";
  return ".png";
}

function refToRelPath(ref: ScreenshotRef): string | null {
  if (!ref.id) return null;
  return `screenshots/${ref.id}${extFromMime(ref.mimeType)}`;
}

interface RawTask {
  uiContext?: { screenshot?: ScreenshotRef };
  recorder?: Array<{ type?: string; screenshot?: ScreenshotRef }>;
}

interface RawExecution {
  tasks?: RawTask[];
}

interface RawExecutionFile {
  executions?: RawExecution[];
}

/** Collect screenshots for all tasks in one execution file, with consecutive-dedup. */
function collectScreenshots(execFile: RawExecutionFile): string[] {
  const paths: string[] = [];
  let last: string | null = null;

  const push = (ref: ScreenshotRef | undefined): void => {
    if (!ref) return;
    const p = refToRelPath(ref);
    if (!p || p === last) return;
    paths.push(p);
    last = p;
  };

  for (const exec of execFile.executions ?? []) {
    for (const task of exec.tasks ?? []) {
      push(task.uiContext?.screenshot);
      for (const rec of task.recorder ?? []) {
        if (rec.type === "screenshot") push(rec.screenshot);
      }
    }
  }

  return paths;
}

// ── Main export ──────────────────────────────────────────────────────

export async function buildTimelineFromReportDir(reportDir: string): Promise<TimelineView> {
  const summary = await readReport(reportDir);
  if (!summary.success) return { revision: 0, steps: [] };

  // Read execution files in numeric order (same order as readReport uses)
  const allFiles = await readdir(reportDir);
  const execFiles = allFiles
    .filter((f) => /^\d+\.execution\.json$/.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(/^(\d+)/)![1], 10);
      const nb = parseInt(b.match(/^(\d+)/)![1], 10);
      return na - nb;
    });

  // Build a screenshot map keyed by execution-file NUMBER (== OperationStep.stepIndex,
  // which readReport derives from the same filename number). Keying by the stable
  // stepIndex — not array position — prevents misattribution when readReport skips a
  // file (parseable but no executions[0]). Mirror readReport's tolerance: skip files
  // that fail to parse (Midscene writes these incrementally, so mid-write truncation
  // is normal) and files without executions[0].
  const screenshotsByStep = new Map<number, string[]>();
  await Promise.all(
    execFiles.map(async (file) => {
      let parsed: RawExecutionFile;
      try {
        const content = await readFile(join(reportDir, file), "utf8");
        parsed = JSON.parse(content) as RawExecutionFile;
      } catch {
        return;
      }
      if (!parsed.executions?.[0]) return;
      const fileNumber = parseInt(file.match(/^(\d+)/)![1], 10);
      screenshotsByStep.set(fileNumber, collectScreenshots(parsed));
    }),
  );

  const steps: TimelineStep[] = summary.steps.map((op) => {
    const firstAction = op.actions[0];
    const action =
      firstAction != null
        ? {
            type: firstAction.type,
            ...(firstAction.target != null ? { target: firstAction.target } : {}),
            ...(firstAction.coordinate != null ? { center: firstAction.coordinate } : {}),
          }
        : undefined;

    return {
      index: op.stepIndex,
      title: op.name,
      status: op.status,
      summary: op.summary,
      ...(op.aiThought != null ? { thought: op.aiThought } : {}),
      ...(action != null ? { action } : {}),
      ...(op.extractedData !== undefined ? { extractedData: op.extractedData } : {}),
      ...(op.error != null ? { error: op.error } : {}),
      screenshots: screenshotsByStep.get(op.stepIndex) ?? [],
    };
  });

  return { revision: steps.length, steps };
}

export async function resolveActiveReportDir(reportRoot: string): Promise<string> {
  if (!existsSync(reportRoot)) return reportRoot;

  let entries: string[];
  try {
    entries = await readdir(reportRoot);
  } catch {
    return reportRoot;
  }

  // Find subdirs that contain at least one N.execution.json
  const candidates: Array<{ dir: string; mtime: number }> = [];
  for (const entry of entries) {
    const fullPath = join(reportRoot, entry);
    let s;
    try {
      s = await stat(fullPath);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;

    let subEntries: string[];
    try {
      subEntries = await readdir(fullPath);
    } catch {
      continue;
    }
    const hasExec = subEntries.some((f) => /^\d+\.execution\.json$/.test(f));
    if (hasExec) candidates.push({ dir: fullPath, mtime: s.mtimeMs });
  }

  if (candidates.length === 0) return reportRoot;

  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].dir;
}

export function mergeWithVisualFlow(view: TimelineView, visualFlow: unknown): TimelineView {
  const planned = buildFlowStepView(visualFlow, []).steps;
  if (planned.length <= view.steps.length) return view;
  const pendingTail = planned.slice(view.steps.length).map((p) => ({
    index: p.index,
    title: p.title,
    status: "pending" as const,
    summary: "",
    screenshots: [] as string[],
  }));
  return { revision: view.revision, steps: [...view.steps, ...pendingTail] };
}
