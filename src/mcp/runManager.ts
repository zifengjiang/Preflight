import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { AgentHttpClient } from "./agentHttpClient.js";
import { buildFlowStepView, extractFlowStepEventsFromRun } from "./flowStepEvents.js";
import { summarizeRun } from "./runSummary.js";
import type { RunState, RunSummary } from "./types.js";

/**
 * MCP transport has a 60s hard timeout.  watchRun blocking must leave
 * enough headroom so the response can be delivered before the transport
 * closes and kills the MCP server process.  55s is the safe ceiling.
 */
const MAX_BLOCK_MS = 45_000;

const TERMINAL = new Set(["SUCCESS", "FAILED", "CANCELLED"]);

const PREFLIGHT_HOME = process.env.PREFLIGHT_HOME?.trim() || `${homedir()}/.preflight`;

function runLogPath(runId: string): string {
  return join(PREFLIGHT_HOME, "runs", runId, "run.log");
}

async function logRun(runId: string, event: string, detail: string): Promise<void> {
  try {
    const dir = join(PREFLIGHT_HOME, "runs", runId);
    await mkdir(dir, { recursive: true });
    const ts = new Date().toISOString();
    await appendFile(join(dir, "run.log"), `${ts} [${event}] ${detail}\n`, "utf8");
  } catch {
    // 日志写失败不影响主流程
  }
}

/** 将 RunState 完整快照写入 state.json，重启后仍可查看 */
async function snapshotRun(run: RunState): Promise<void> {
  try {
    const dir = join(PREFLIGHT_HOME, "runs", run.runId);
    await writeFile(join(dir, "state.json"), JSON.stringify(run, null, 2), "utf8");
  } catch {
    // 快照写失败不影响主流程
  }
}

export class RunManager {
  private readonly runs = new Map<string, RunState>();

  constructor(
    private readonly client: AgentHttpClient,
    private liveBaseUrl: string,
  ) {}

  setLiveBaseUrl(liveBaseUrl: string): void {
    this.liveBaseUrl = liveBaseUrl;
  }

  async startRun(input: {
    platform: string;
    script: string;
    scriptKind?: "midscene" | "airtest";
    resourceId?: string;
    appRef?: string;
    testIntent?: string;
    runtimeEnv?: Record<string, string>;
    visualFlow?: unknown;
  }): Promise<RunSummary> {
    const runId = timestampId();
    const taskId = `mcp-${runId}`;
    const now = new Date().toISOString();
    const liveUrl = `${this.liveBaseUrl.replace(/\/$/, "")}/runs/${encodeURIComponent(runId)}/live`;
    const run: RunState = {
      runId,
      taskId,
      platform: input.platform,
      resourceId: input.resourceId,
      appRef: input.appRef,
      testIntent: input.testIntent,
      script: input.script,
      visualFlow: input.visualFlow,
      createdAt: now,
      updatedAt: now,
      liveUrl,
      events: [],
      artifacts: [],
    };
    this.runs.set(runId, run);
    logRun(runId, "START", `platform=${input.platform}, testIntent=${input.testIntent ?? ""}, ${input.resourceId ? `resourceId=${input.resourceId}` : ""}`);
    await this.client.createTask({
      taskId,
      requiredPlatform: input.platform,
      script: input.script,
      scriptKind: input.scriptKind,
      resourceId: input.resourceId,
      runtimeEnv: input.runtimeEnv,
    });
    await this.refreshRun(runId);
    snapshotRun(this.mustGet(runId));
    return summarizeRun(this.mustGet(runId));
  }

  async cancelRun(runId: string, source: string, detail: string): Promise<RunSummary> {
    const run = this.mustGet(runId);
    const now = new Date().toISOString();
    run.termination = { source, detail, timestamp: now };
    run.updatedAt = now;
    logRun(runId, "CANCEL", `source=${source}, detail=${detail}`);
    snapshotRun(run);
    return summarizeRun(run);
  }

  async watchRun(runId: string, minIntervalMs?: number): Promise<RunSummary> {
    await this.refreshRun(runId);
    const summary = summarizeRun(this.mustGet(runId));
    if (TERMINAL.has(summary.status)) {
      logRun(runId, "END", `status=${summary.status}, failure=${summary.failureAnalysis.category}`);
      return summary;
    }
    if (!minIntervalMs || minIntervalMs <= 0) {
      return summary;
    }
    // 安全上限：MCP transport 有 60s 硬超时，阻塞必须留余量
    const safeInterval = Math.min(minIntervalMs, MAX_BLOCK_MS);
    const deadline = Date.now() + safeInterval;
    while (Date.now() < deadline) {
      await sleep(Math.min(2000, deadline - Date.now()));
      await this.refreshRun(runId);
      const latest = summarizeRun(this.mustGet(runId));
      if (TERMINAL.has(latest.status)) {
        logRun(runId, "END", `status=${latest.status}, failure=${latest.failureAnalysis.category}`);
        return latest;
      }
    }
    await this.refreshRun(runId);
    return summarizeRun(this.mustGet(runId));
  }

  getRun(runId: string): RunState | undefined {
    return this.runs.get(runId);
  }

  listRuns(): RunState[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async waitForRun(runId: string, timeoutMs: number, pollIntervalMs: number): Promise<RunSummary> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const summary = await this.watchRun(runId);
      if (TERMINAL.has(summary.status)) return summary;
      await sleep(pollIntervalMs);
    }
    return this.watchRun(runId);
  }

  private async refreshRun(runId: string): Promise<void> {
    const run = this.mustGet(runId);
    const [task, events, artifacts] = await Promise.all([
      this.client.getTask(run.taskId),
      this.client.listEvents(run.taskId).catch(() => run.events),
      this.client.listArtifacts(run.taskId).catch(() => run.artifacts),
    ]);
    run.task = task ?? run.task;
    run.events = events;
    run.artifacts = artifacts;
    run.flowStepView = buildFlowStepView(run.visualFlow, extractFlowStepEventsFromRun(run));
    run.updatedAt = new Date().toISOString();
    snapshotRun(run);
  }

  private mustGet(runId: string): RunState {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown runId: ${runId}`);
    return run;
  }
}

function timestampId(): string {
  const stamp = new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\..+$/, "");
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
