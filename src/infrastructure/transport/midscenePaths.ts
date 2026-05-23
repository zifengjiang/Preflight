import path from "node:path";

export function resolveMidsceneRunDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = env.MIDSCENE_RUN_DIR?.trim() || "midscene_run";
  if (path.isAbsolute(base)) return base;
  const agentHome = env.AGENT_HOME?.trim();
  if (agentHome) return path.resolve(agentHome, base);
  return path.resolve(cwd, base);
}

/** 与 @midscene/shared 默认一致：run dir 下 `report`。 */
export function getMidsceneReportRootDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveMidsceneRunDir(cwd, env), "report");
}

export function resolveTaskReportFilePaths(
  reportRoot: string,
  reportStem: string,
  outputFormat: "single-html" | "html-and-external-assets",
): { reportHtmlPath: string; bundleDir?: string; reportName: string } {
  if (outputFormat === "html-and-external-assets") {
    const bundleDir = path.join(reportRoot, reportStem);
    return {
      reportName: reportStem,
      reportHtmlPath: path.join(bundleDir, "index.html"),
      bundleDir,
    };
  }
  return {
    reportName: `${reportStem}.html`,
    reportHtmlPath: path.join(reportRoot, `${reportStem}.html`),
  };
}
