import type { FailureAnalysis, RunState, RunSummary } from "./types.js";

const TERMINAL_STATUSES = new Set(["SUCCESS", "FAILED", "CANCELLED"]);

export function summarizeRun(run: RunState): RunSummary {
  const eventStatus = [...run.events]
    .reverse()
    .map((event) => event.payload.status)
    .find((status): status is string => typeof status === "string");
  const status = run.task?.status ?? eventStatus ?? "UNKNOWN";
  const failureText = status === "FAILED" ? run.task?.message ?? latestEventMessage(run) ?? "" : "";

  return {
    runId: run.runId,
    taskId: run.taskId,
    status,
    liveUrl: run.liveUrl,
    updatedAt: run.updatedAt,
    artifacts: run.artifacts,
    failureAnalysis: TERMINAL_STATUSES.has(status) ? analyzeRunFailure(failureText, status) : runningAnalysis(status),
  };
}

export function analyzeRunFailure(message: string, status = "FAILED"): FailureAnalysis {
  if (status === "SUCCESS") {
    return { category: "none", summary: "No failure.", recommendation: "No retry needed." };
  }
  if (status === "CANCELLED") {
    return {
      category: "agent-or-runtime",
      summary: "The run was cancelled before completion.",
      recommendation: "Start a new run after confirming the device is free.",
    };
  }

  const lower = message.toLowerCase();

  // timeout must be checked before adb — the Agent's error message often
  // includes ADB debug log lines (e.g. "dbug ADB Running 'adb -H ...'")
  // concatenated with a timeout suffix.  If "adb" is checked first these
  // timeouts are misclassified as device-or-environment.
  if (lower.includes("timeout") || lower.includes("api key") || lower.includes("midscene") || lower.includes("spawn")) {
    return {
      category: "agent-or-runtime",
      summary: message || "The run failed in the agent or Midscene runtime.",
      recommendation: "Run doctor, fix blocking runtime checks, then rerun.",
    };
  }
  if (
    lower.includes("adb") ||
    lower.includes("hdc") ||
    lower.includes("wda") ||
    lower.includes("iproxy") ||
    lower.includes("device offline") ||
    lower.includes("no device")
  ) {
    return {
      category: "device-or-environment",
      summary: message || "The run failed in device or environment setup.",
      recommendation: "Check the device connection, adb/hdc/WDA availability, then rerun the same test.",
    };
  }
  return {
    category: "test-or-app-behavior",
    summary: message || "The run failed while executing the generated test steps.",
    recommendation: "Inspect the live viewer/report, adjust the test steps if they were too brittle, or file a product bug if the app behavior is wrong.",
  };
}

function runningAnalysis(status: string): FailureAnalysis {
  return {
    category: "none",
    summary: `Run is still ${status}.`,
    recommendation: "Continue watching the run before changing the test case.",
  };
}

function latestEventMessage(run: RunState): string | undefined {
  return [...run.events]
    .reverse()
    .map((event) => event.payload.message)
    .find((message): message is string => typeof message === "string");
}
