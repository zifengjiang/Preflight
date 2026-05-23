import type { AgentEventSnapshot, RunState } from "./types.js";

export interface FlowStepEvent {
  type: "start" | "end" | "error";
  stepIndex: number;
  ts: number;
  durationMs?: number;
  message?: string;
  iteration?: number;
}

export interface FlowStepViewItem {
  index: number;
  type: string;
  title: string;
  status: "pending" | "running" | "passed" | "failed";
  durationMs?: number;
  message?: string;
  depth: number;
}

export interface FlowStepView {
  currentStepIndex?: number;
  steps: FlowStepViewItem[];
  events: FlowStepEvent[];
}

const PREFIX = "__FLOW_STEP_EVENT__";

export function extractFlowStepEventsFromRun(run: Pick<RunState, "events">): FlowStepEvent[] {
  const out: FlowStepEvent[] = [];
  for (const event of run.events) {
    for (const text of candidateTexts(event)) {
      out.push(...extractFlowStepEventsFromText(text));
    }
  }
  return out.sort((a, b) => a.ts - b.ts || a.stepIndex - b.stepIndex);
}

export function extractFlowStepEventsFromText(text: string): FlowStepEvent[] {
  const out: FlowStepEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(PREFIX);
    if (idx < 0) continue;
    const json = line.slice(idx + PREFIX.length).trim();
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      const type = parsed.type;
      const stepIndex = Number(parsed.stepIndex);
      const ts = Number(parsed.ts);
      if ((type !== "start" && type !== "end" && type !== "error") || !Number.isFinite(stepIndex) || !Number.isFinite(ts)) {
        continue;
      }
      out.push({
        type,
        stepIndex,
        ts,
        ...(Number.isFinite(Number(parsed.durationMs)) ? { durationMs: Number(parsed.durationMs) } : {}),
        ...(typeof parsed.message === "string" ? { message: parsed.message } : {}),
        ...(Number.isFinite(Number(parsed.iteration)) ? { iteration: Number(parsed.iteration) } : {}),
      });
    } catch {
      // Ignore non-JSON log lines.
    }
  }
  return out;
}

export function buildFlowStepView(visualFlow: unknown, events: FlowStepEvent[]): FlowStepView {
  const steps = flattenVisualFlowSteps(visualFlow);
  const latestByStep = new Map<number, FlowStepEvent>();
  for (const event of events) latestByStep.set(event.stepIndex, event);
  const current = [...events].reverse().find((event) => event.type === "start" || event.type === "error");

  return {
    currentStepIndex: current?.stepIndex,
    events,
    steps: steps.map((step) => {
      const latest = latestByStep.get(step.index);
      return {
        ...step,
        status: latest?.type === "end" ? "passed" : latest?.type === "error" ? "failed" : latest?.type === "start" ? "running" : "pending",
        ...(latest?.durationMs != null ? { durationMs: latest.durationMs } : {}),
        ...(latest?.message ? { message: latest.message } : {}),
      };
    }),
  };
}

function candidateTexts(event: AgentEventSnapshot): string[] {
  const payload = event.payload ?? {};
  const keys = ["chunk", "message", "log", "text", "stdout", "stderr"];
  const out: string[] = [];
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.includes(PREFIX)) out.push(value);
  }
  return out;
}

function flattenVisualFlowSteps(visualFlow: unknown): Array<Omit<FlowStepViewItem, "status">> {
  const root = visualFlow && typeof visualFlow === "object" ? (visualFlow as { steps?: unknown }) : {};
  const steps = Array.isArray(root.steps) ? root.steps : [];
  const out: Array<Omit<FlowStepViewItem, "status">> = [];
  let index = 0;
  const walk = (items: unknown[], depth: number): void => {
    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const step = item as Record<string, unknown>;
      const type = typeof step.type === "string" ? step.type : "unknown";
      index += 1;
      out.push({ index, type, title: describeStep(type, step), depth });
      if (type === "if" || type === "ifDeviceType") {
        if (Array.isArray(step.thenSteps)) walk(step.thenSteps, depth + 1);
        if (Array.isArray(step.elseSteps)) walk(step.elseSteps, depth + 1);
      } else if (type === "whileLoop" || type === "forLoop") {
        if (Array.isArray(step.bodySteps)) walk(step.bodySteps, depth + 1);
      }
    }
  };
  walk(steps, 0);
  return out;
}

function describeStep(type: string, step: Record<string, unknown>): string {
  const primary =
    stringField(step, "prompt") ??
    stringField(step, "locatePrompt") ??
    stringField(step, "conditionPrompt") ??
    stringField(step, "packageName") ??
    stringField(step, "bundleId") ??
    stringField(step, "appRef") ??
    stringField(step, "expression") ??
    stringField(step, "title");
  return primary ? `${type}: ${primary}` : type;
}

function stringField(step: Record<string, unknown>, key: string): string | undefined {
  const value = step[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
