import { readFile } from "node:fs/promises";
import type { CommandRunner } from "../infrastructure/system/CommandRunner.js";

type WdaPortMapState = {
  portsByUdid?: Record<string, number | string>;
};

export function extractIosUdidFromResourceId(resourceId: string): string {
  const raw = String(resourceId).trim();
  const idx = raw.indexOf(":");
  return idx >= 0 ? raw.slice(idx + 1).trim() : raw;
}

export function normalizeIosWdaPortRange(start: number, end: number): { start: number; end: number } {
  const s = Number.isFinite(start) && start > 0 ? Math.floor(start) : 8200;
  const e = Number.isFinite(end) && end > 0 ? Math.floor(end) : 8399;
  return s <= e ? { start: s, end: e } : { start: e, end: s };
}

export async function readMappedWdaPortForUdid(mapFilePath: string | undefined, udid: string): Promise<number | undefined> {
  const path = mapFilePath?.trim();
  if (!path) return undefined;
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as WdaPortMapState;
    const portRaw = parsed.portsByUdid?.[udid];
    const port = Number(portRaw);
    if (!Number.isFinite(port) || port <= 0) return undefined;
    return Math.floor(port);
  } catch {
    return undefined;
  }
}

export async function isWdaHealthy(
  commandRunner: CommandRunner,
  wdaHost: string,
  wdaPort: number,
  timeoutMs = 2_000,
): Promise<boolean> {
  const host = wdaHost.trim() || "127.0.0.1";
  const url = `http://${host}:${wdaPort}/status`;
  const curlTimeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
  const command = `curl -fsS --max-time ${curlTimeoutSeconds} ${JSON.stringify(url)}`;
  const result = await commandRunner.run(command, timeoutMs + 500);
  if (!result.ok) return false;
  return result.stdout.trim().length > 0;
}

async function findFirstHealthyWdaPortInRange(
  commandRunner: CommandRunner,
  wdaHost: string,
  rangeStart: number,
  rangeEnd: number,
): Promise<number | undefined> {
  const { start, end } = normalizeIosWdaPortRange(rangeStart, rangeEnd);
  for (let port = start; port <= end; port += 1) {
    if (await isWdaHealthy(commandRunner, wdaHost, port, 300)) {
      return port;
    }
  }
  return undefined;
}

export interface ResolveIosWdaPortForLiveDebugParams {
  resourceId: string;
  wdaHost: string;
  portMapFilePath?: string;
  portRangeStart: number;
  portRangeEnd: number;
  /** 单设备调试时可设 MIDSCENE_IOS_WDA_PORT / IOS_WDA_PORT */
  explicitWdaPort?: number;
}

/**
 * 解析实时看屏可用的 WDA 端口（与 MidsceneRuntimeReal.prepareIosSession 优先级对齐：显式端口 → 映射文件 → 区间扫描）。
 * 不在此函数内启动 WDA；需先由 watchdog / 任务 / 手动拉起 WDA。
 */
export async function resolveIosWdaPortForLiveDebug(
  commandRunner: CommandRunner,
  params: ResolveIosWdaPortForLiveDebugParams,
): Promise<number> {
  const wdaHost = params.wdaHost.trim() || "127.0.0.1";
  const udid = extractIosUdidFromResourceId(params.resourceId);

  const explicit = params.explicitWdaPort;
  if (Number.isFinite(explicit) && explicit! > 0) {
    const p = Math.floor(explicit!);
    if (await isWdaHealthy(commandRunner, wdaHost, p)) return p;
    throw new Error(
      `iOS 实时看屏：环境变量指定的 WDA 端口 ${p} 不可用（${wdaHost}）。请检查 WDA 是否已启动或端口是否正确。`,
    );
  }

  const mapped = await readMappedWdaPortForUdid(params.portMapFilePath, udid);
  if (mapped != null) {
    if (await isWdaHealthy(commandRunner, wdaHost, mapped)) return mapped;
    throw new Error(
      `iOS 实时看屏：端口映射中 ${udid} 对应端口 ${mapped} 的 WDA 不可访问（${wdaHost}）。请检查 WDA 或 IOS_WDA_WATCHDOG，勿在未映射时使用区间扫描以免连错设备。`,
    );
  }

  const scanned = await findFirstHealthyWdaPortInRange(commandRunner, wdaHost, params.portRangeStart, params.portRangeEnd);
  if (scanned != null) return scanned;

  throw new Error(
    `iOS 实时看屏：未在 ${wdaHost} 上找到可用 WDA（端口区间 ${params.portRangeStart}-${params.portRangeEnd}）。请启动 WDA、配置 IOS_WDA_PORT_MAP_FILE_PATH，或设置 MIDSCENE_IOS_WDA_PORT。`,
  );
}
