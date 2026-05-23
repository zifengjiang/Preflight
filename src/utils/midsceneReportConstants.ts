import { randomBytes } from "node:crypto";

/**
 * 与 `PlatformType` 同值，但不 import `shared-kernel`：task runner 由 `tsx`/`node` 直跑时
 * 若解析到 `.ts` 再链到仅存在 `.ts` 的 `enums/index.js` 会触发 ERR_MODULE_NOT_FOUND。
 */
export type MidsceneReportPlatform = "HARMONY" | "ANDROID" | "IOS" | "WEB";

/**
 * 供未注入任务上下文时的回退名（如本地调试、非任务入口调用 runner）。
 * @midscene/core 会拼 `${reportFileName}.html`；不要传入已含 `.html` 的整文件名。
 */
export const MIDSCENE_DEFAULT_REPORT_STEM = `report-${new Date()
  .toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
  .replace(/[^\d]/g, "-")
  .replace(/-$/, "")}`;

const PLATFORM_PREFIX: Record<MidsceneReportPlatform, string> = {
  ANDROID: "android",
  IOS: "ios",
  HARMONY: "harmony",
  WEB: "web",
};

/**
 * 将 taskId 转为可安全作为 Midscene 报告名一部分的 token（无路径分隔符、控制字符）。
 */
export function sanitizeTaskIdForReportName(taskId: string): string {
  const s = String(taskId).trim() || "unknown";
  return s
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 96) || "unknown";
}

function randomSuffix(): string {
  return randomBytes(4).toString("hex");
}

/**
 * 生成本次任务在 Midscene `reportFileName`（无后缀）的 stem，包含平台与 taskId 便于对账与排查。
 * 子进程经 `MIDSCENE_FLOW_REPORT_STEM` 读取；由 Task 下发时在 runtimeEnv 中设置。
 */
export function buildMidsceneReportStemForTask(
  requiredPlatform: MidsceneReportPlatform,
  taskId: string,
  startedAtMs = Date.now(),
): string {
  const p = PLATFORM_PREFIX[requiredPlatform] ?? "app";
  return `${p}-task-${sanitizeTaskIdForReportName(taskId)}-${startedAtMs}-${randomSuffix()}`;
}

/** 兼容旧 import：模块级默认 stem（无 task 上下文）。 */
export const MIDSCENE_REPORT_FILE_STEM = MIDSCENE_DEFAULT_REPORT_STEM;
export const MIDSCENE_REPORT_FILE_NAME = `${MIDSCENE_DEFAULT_REPORT_STEM}.html`;
export const MIDSCENE_REPORT_GZIP_FILE_NAME = `${MIDSCENE_DEFAULT_REPORT_STEM}.html.gz`;
