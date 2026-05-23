import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface PreflightUserConfig {
  path?: string;
  env: Record<string, string>;
}

const CONFIG_PATHS = [
  join(homedir(), ".preflight", "config.json"),
  join(homedir(), ".preflight", "config.yaml"),
  join(homedir(), ".preflight", "config.yml"),
];

export async function loadPreflightUserConfig(): Promise<PreflightUserConfig> {
  for (const path of CONFIG_PATHS) {
    const raw = await readFile(path, "utf8").catch(() => undefined);
    if (raw === undefined) continue;
    const parsed = path.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
    return { path, env: flattenConfig(parsed) };
  }
  return { env: {} };
}

function flattenConfig(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const root = value as Record<string, unknown>;
  const envCandidate = root.env && typeof root.env === "object" && !Array.isArray(root.env) ? root.env : root;
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(envCandidate as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    const text = scalarToString(rawValue);
    if (text === undefined || !text.trim()) continue;
    out[key] = text;
  }
  return out;
}

function scalarToString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return undefined;
}
