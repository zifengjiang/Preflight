import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/** 显式路径；未设置时使用 `process.cwd()/config.yaml`。 */
export function resolveAgentConfigPath(): string {
  const fromEnv = process.env.AGENT_CONFIG_PATH?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(process.cwd(), "config.yaml");
}

function scalarToEnvString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return value;
  return undefined;
}

/** 仅接受顶层的标量键；嵌套对象会被跳过并打日志。 */
export function flattenYamlConfigToEnv(doc: unknown): Record<string, string> {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return {};
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(doc as Record<string, unknown>)) {
    const key = k.trim();
    if (!key) continue;
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      console.warn(`[config] 跳过非标量配置项（请改为顶层 UPPER_SNAKE_CASE）: ${key}`);
      continue;
    }
    if (Array.isArray(raw)) {
      console.warn(`[config] 跳过数组配置项: ${key}`);
      continue;
    }
    const s = scalarToEnvString(raw);
    if (s === undefined) continue;
    out[key] = s;
  }
  return out;
}

/**
 * 读取单一 `config.yaml`，将其中出现的键写入 `process.env`（覆盖已有值）。
 * 文件不存在时静默跳过；解析失败时打错误并 `process.exit(1)`。
 */
export function applyAgentConfigFileToProcessEnv(): void {
  const configPath = resolveAgentConfigPath();
  if (!fs.existsSync(configPath)) {
    return;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (e) {
    console.error(`[config] 无法读取配置文件: ${configPath}`, e);
    process.exit(1);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    console.error(`[config] YAML 解析失败: ${configPath}`, e);
    process.exit(1);
  }
  const flat = flattenYamlConfigToEnv(parsed);
  const n = Object.keys(flat).length;
  for (const [k, v] of Object.entries(flat)) {
    process.env[k] = v;
  }
  if (n > 0) {
    console.info(`[config] 已从 ${configPath} 加载 ${n} 项环境变量`);
  }
}

/**
 * 若 `AGENT_HTTP_TOKEN` / `PLATFORM_WS_TOKEN` / `PLATFORM_AGENT_CALLBACK_TOKEN` 中仅部分填写
 *（与平台共用同一 Bearer 时常见），将已填项回填到未填项，便于只配一处。
 *
 * 回填顺序：HTTP 缺省 ← WS → 回调；WS 缺省 ← HTTP → 回调；回调缺省 ← HTTP → WS。
 */
export function applyMutualAgentAuthTokenFallbackToProcessEnv(): void {
  const h = process.env.AGENT_HTTP_TOKEN?.trim() ?? "";
  const w = process.env.PLATFORM_WS_TOKEN?.trim() ?? "";
  const c = process.env.PLATFORM_AGENT_CALLBACK_TOKEN?.trim() ?? "";
  if (!h && (w || c)) process.env.AGENT_HTTP_TOKEN = w || c;
  if (!w && (h || c)) process.env.PLATFORM_WS_TOKEN = h || c;
  if (!c && (h || w)) process.env.PLATFORM_AGENT_CALLBACK_TOKEN = h || w;
}
