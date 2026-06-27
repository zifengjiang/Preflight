import { join, isAbsolute, resolve } from "node:path";

/** Mirror of infrastructure/transport/midscenePaths but driven by an explicit runtimeRoot. */
export function resolveRunReportDir(opts: { runtimeRoot: string; env: Record<string, string | undefined> }): string {
  const base = opts.env.MIDSCENE_RUN_DIR?.trim() || "midscene_run";
  const runDir = isAbsolute(base) ? base : resolve(opts.runtimeRoot, base);
  return join(runDir, "report");
}
