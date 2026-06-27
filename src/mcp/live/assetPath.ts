import { resolve, sep } from "node:path";

/** Resolve a report-relative asset path under baseDir, rejecting path traversal. Returns null if outside baseDir. */
export function resolveSafeAssetPath(baseDir: string, rel: string): string | null {
  const cleaned = rel.replace(/\\/g, "/");
  const base = resolve(baseDir);
  const abs = resolve(base, cleaned);
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  return abs;
}
