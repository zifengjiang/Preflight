import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

// ── Types ───────────────────────────────────────────────────────────

export interface OperationStep {
  /** 1-based step number from the execution sequence */
  stepIndex: number;
  /** Name from the execution JSON (e.g. "Act - xxx", "Terminate", "Query - xxx") */
  name: string;
  /** Overall status of this execution */
  status: "finished" | "failed";
  /** Human-readable summary of what happened in this step */
  summary: string;
  /** The raw AI thought (if available) */
  aiThought?: string;
  /** All low-level operations performed as part of this step (tap, longPress, etc.) */
  actions: ActionDetail[];
  /** Data extracted by Query / Number / Boolean steps */
  extractedData?: unknown;
  /** Error message if the step failed */
  error?: string;
}

export interface ActionDetail {
  type: string; // "Tap" | "LongPress" | "Swipe" | "Launch" | "Terminate" | ...
  target?: string;
  coordinate?: [number, number];
  bbox?: [number, number, number, number];
  result?: string;
}

export interface ReportSummary {
  /** Whether the report was read successfully */
  success: boolean;
  /** The report directory path */
  reportDir: string;
  /** Number of execution steps found */
  stepCount: number;
  /** The full operation timeline */
  steps: OperationStep[];
  /** Any error during reading */
  error?: string;
}

// ── Parser ──────────────────────────────────────────────────────────

/**
 * Read a Midscene report directory (containing N.execution.json files)
 * and extract the full operation path.
 */
export async function readReport(reportDir: string): Promise<ReportSummary> {
  if (!existsSync(reportDir)) {
    return { success: false, reportDir, stepCount: 0, steps: [], error: `Report directory not found: ${reportDir}` };
  }

  const allFiles = await readdir(reportDir);
  const execFiles = allFiles
    .filter((f) => /^\d+\.execution\.json$/.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(/^(\d+)/)![1], 10);
      const nb = parseInt(b.match(/^(\d+)/)![1], 10);
      return na - nb;
    });

  if (execFiles.length === 0) {
    return { success: false, reportDir, stepCount: 0, steps: [], error: `No *.execution.json files found in: ${reportDir}` };
  }

  const steps: OperationStep[] = [];
  for (const file of execFiles) {
    const content = await readFile(join(reportDir, file), "utf8");
    const step = parseExecutionFile(content, file);
    if (step) steps.push(step);
  }

  return { success: true, reportDir, stepCount: steps.length, steps };
}

// ── Internal parsing ────────────────────────────────────────────────

interface ExecutionFile {
  name?: string;
  description?: string;
  tasks: ExecutionTask[];
}

interface ExecutionTask {
  type?: string;
  subType?: string;
  status?: string;
  thought?: string;
  param?: unknown;
  output?: {
    actions?: Array<{
      type?: string;
      param?: {
        locate?: {
          description?: string;
          center?: [number, number];
          rect?: { left: number; top: number; width: number; height: number };
        };
      };
    }>;
    log?: string;
    thought?: string;
    output?: string;
    element?: {
      rect?: { left: number; top: number; width: number; height: number };
      center?: [number, number];
      description?: string;
    };
  };
  log?: {
    rawResponse?: string;
    data?: unknown;
  };
  error?: unknown;
  errorMessage?: string;
}

function parseExecutionFile(content: string, filename: string): OperationStep | null {
  let parsed: { executions?: ExecutionFile[] };
  try {
    parsed = JSON.parse(content) as { executions?: ExecutionFile[] };
  } catch {
    return null;
  }

  const exec = parsed.executions?.[0];
  if (!exec) return null;

  // Extract name like "Terminate", "Launch", "Act - xxx", "Query - xxx", "Number - xxx", etc.
  const rawName = exec.name ?? filename.replace(/\.execution\.json$/, "");
  const tasks = exec.tasks ?? [];
  const description = exec.description;

  // Determine overall status
  const hasFailedTask = tasks.some((t) => t.status === "failed");
  const status: "finished" | "failed" = hasFailedTask ? "failed" : "finished";

  // Extract AI thought from the Planning task
  const planTask = tasks.find((t) => t.subType === "Plan");
  const aiThought = planTask?.output?.thought ?? planTask?.thought;

  // Extract all actions
  const actions: ActionDetail[] = [];
  for (const task of tasks) {
    if (task.type === "Action Space" && task.subType) {
      const actionType = task.subType; // "Tap", "LongPress", "Terminate", "Launch"
      const locate = (task.param as { locate?: { description?: string; center?: [number, number]; rect?: { left: number; top: number; width: number; height: number } } })?.locate;
      const action: ActionDetail = { type: actionType };
      if (locate?.description) action.target = locate.description;
      if (locate?.center) action.coordinate = [locate.center[0], locate.center[1]];
      if (locate?.rect) {
        action.bbox = [locate.rect.left, locate.rect.top, locate.rect.width, locate.rect.height];
      }
      action.result = task.status === "finished" ? "success" : "failed";
      actions.push(action);
    }
    // Also read actions from the Planning output
    if (task.output?.actions) {
      for (const act of task.output.actions) {
        const existing = actions.find((a) => a.type === act.type && a.target === act.param?.locate?.description);
        if (!existing && act.type) {
          actions.push({
            type: act.type,
            target: act.param?.locate?.description,
            coordinate: act.param?.locate?.center,
            bbox: act.param?.locate?.rect
              ? [act.param.locate.rect.left, act.param.locate.rect.top, act.param.locate.rect.width, act.param.locate.rect.height]
              : undefined,
            result: "planned",
          });
        }
      }
    }
    // Also extract locate elements for LongPress
    if (task.subType === "Locate" && task.output?.element) {
      // Already captured by the Plan output actions
    }
  }

  // Extract data from Insight tasks (Query / Number / Boolean / Assert)
  let extractedData: unknown = undefined;
  let error: string | undefined = undefined;
  for (const task of tasks) {
    if (task.type === "Insight") {
      if (task.subType === "Query" || task.subType === "Number" || task.subType === "Boolean") {
        extractedData = task.output;
      }
      if (task.subType === "Assert") {
        if (task.status === "failed") {
          error = task.errorMessage ?? "Assertion failed";
        }
        extractedData = task.output;
      }
    }
    if (task.status === "failed" && task.errorMessage) {
      error = task.errorMessage;
    }
  }

  // Build summary from the log/output
  let summary: string;
  if (description) {
    summary = description;
  } else if (rawName.startsWith("Terminate")) {
    summary = `关闭应用 ${tasks.find((t) => t.subType === "Terminate")?.param ?? ""}`;
  } else if (rawName.startsWith("Launch")) {
    summary = `启动应用 ${tasks.find((t) => t.subType === "Launch")?.param ?? ""}`;
  } else if (rawName.startsWith("Act -")) {
    summary = rawName.slice(5).trim();
    const actionLog = planTask?.output?.log;
    if (actionLog) summary = actionLog;
    if (status === "failed") summary += " (失败)";
  } else if (rawName.startsWith("Query -")) {
    summary = `读取数据: ${JSON.stringify(extractedData ?? "")}`;
  } else if (rawName.startsWith("Number -")) {
    summary = `计数结果: ${JSON.stringify(extractedData ?? "")}`;
  } else if (rawName.startsWith("Boolean -")) {
    summary = `条件判断: ${JSON.stringify(extractedData ?? "")}`;
  } else if (rawName.startsWith("Assert -")) {
    const assertResult = status === "finished" ? "通过" : "失败";
    summary = `断言 ${assertResult}: ${rawName.slice(7).trim()}`;
  } else if (rawName.startsWith("Log -")) {
    summary = `记录日志: ${description ?? ""}`;
  } else {
    summary = rawName;
  }

  // If there's an error, append it to summary
  if (error) {
    summary += ` | 错误: ${error.slice(0, 200)}`;
  }

  // Derive step index from filename
  const stepIndex = parseInt(filename.match(/^(\d+)/)?.[1] ?? "0", 10);

  return { stepIndex, name: rawName, status, summary, aiThought, actions, extractedData, error };
}
