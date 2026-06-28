import { join, isAbsolute, resolve } from "node:path";

/** Mirror of infrastructure/transport/midscenePaths but driven by an explicit runtimeRoot. */
export function resolveRunReportDir(opts: { runtimeRoot: string; env: Record<string, string | undefined> }): string {
  const base = opts.env.MIDSCENE_RUN_DIR?.trim() || "midscene_run";
  if (isAbsolute(base)) return join(base, "report");
  // The agent (resolveMidsceneRunDir) resolves a relative run dir against AGENT_HOME
  // (the runtime launches the agent with AGENT_HOME=PREFLIGHT_HOME), so reports land under
  // <AGENT_HOME>/midscene_run — NOT <runtimeRoot>/midscene_run. Mirror that, else run.reportDir
  // points at a nonexistent dir and both the live timeline and evidence come up empty.
  const agentHome = opts.env.AGENT_HOME?.trim() || opts.env.PREFLIGHT_HOME?.trim();
  const runDir = resolve(agentHome || opts.runtimeRoot, base);
  return join(runDir, "report");
}
