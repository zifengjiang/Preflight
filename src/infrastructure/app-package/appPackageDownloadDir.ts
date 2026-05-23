import path from "node:path";

export function resolveAppPackageDownloadDir(
  rawDownloadDir: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string | undefined {
  const trimmed = rawDownloadDir?.trim();
  if (!trimmed) return undefined;
  if (path.isAbsolute(trimmed)) return trimmed;

  const agentHome = env.AGENT_HOME?.trim();
  if (agentHome) {
    return path.resolve(agentHome, trimmed);
  }
  return path.resolve(cwd, trimmed);
}
