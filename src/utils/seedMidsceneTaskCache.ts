import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveMidsceneRunDir } from "../infrastructure/transport/midscenePaths.js";

/** 与 `@midscene/shared` 的 `midscene_run/cache` 路径约定一致，避免 Agent 包未显式依赖 `@midscene/shared`。 */
const DEFAULT_RUN_DIR = "midscene_run";

function getMidsceneRunBaseDir(env: NodeJS.ProcessEnv | Record<string, string>): string {
  let basePath = resolveMidsceneRunDir(process.cwd(), env as NodeJS.ProcessEnv);
  if (!existsSync(basePath)) {
    try {
      mkdirSync(basePath, { recursive: true });
    } catch {
      basePath = path.join(tmpdir(), DEFAULT_RUN_DIR);
      mkdirSync(basePath, { recursive: true });
    }
  }
  return basePath;
}

function getMidsceneCacheDir(env: NodeJS.ProcessEnv | Record<string, string>): string {
  const p = path.join(getMidsceneRunBaseDir(env), "cache");
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  return p;
}

/**
 * 在启动 Midscene 子进程前，将平台下发的缓存 YAML 写入 `midscene_run/cache/<id>.cache.yaml`。
 * 环境变量：`MIDSCENE_TASK_CACHE_ID`、`MIDSCENE_TASK_CACHE_SEED_YAML_B64`（UTF-8 文本的 base64）。
 */
export function seedMidsceneTaskCacheFromRuntimeEnv(runtimeEnv: Record<string, string>): void {
  const id = String(runtimeEnv.MIDSCENE_TASK_CACHE_ID ?? "").trim();
  const b64 = String(runtimeEnv.MIDSCENE_TASK_CACHE_SEED_YAML_B64 ?? "").trim();
  if (!id || !b64) return;
  let text: string;
  try {
    text = Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return;
  }
  if (!text.trim()) return;
  const dir = getMidsceneCacheDir(runtimeEnv);
  const fp = path.join(dir, `${id}.cache.yaml`);
  writeFileSync(fp, text, "utf8");
}

export async function readMidsceneTaskCacheFileIfExists(
  runtimeEnv: Record<string, string>,
): Promise<{ relativePath: string; base64: string } | null> {
  const id = String(runtimeEnv.MIDSCENE_TASK_CACHE_ID ?? "").trim();
  if (!id) return null;
  const fp = path.join(getMidsceneCacheDir(runtimeEnv), `${id}.cache.yaml`);
  if (!existsSync(fp)) return null;
  const { readFile } = await import("node:fs/promises");
  const buf = await readFile(fp);
  return {
    relativePath: `midscene-cache/${id}.cache.yaml`,
    base64: buf.toString("base64"),
  };
}
