import type { InstallAppCommand, UninstallAppCommand } from "../protocol-contracts/commands/index.js";

/** 调用本机 Agent `POST /platform/commands` 时的可选配置；未传则从环境变量读取。 */
export type AgentHttpClientOptions = {
  /** 无尾斜杠。优先于 `AGENT_HTTP_BASE_URL`；再否则 `http://127.0.0.1:${AGENT_HTTP_PORT ?? 18998}` */
  baseUrl?: string;
  /** 缺省读 `AGENT_HTTP_TOKEN`（与 Agent `HttpServer` 鉴权一致） */
  token?: string;
  signal?: AbortSignal;
  /** 测试注入 */
  fetchImpl?: typeof fetch;
};

export class AgentHttpCommandError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "AgentHttpCommandError";
  }
}

function resolveBaseUrl(explicit?: string): string {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed.replace(/\/$/, "");
  const fromTask = process.env.AGENT_HTTP_BASE_URL?.trim();
  if (fromTask) return fromTask.replace(/\/$/, "");
  const fromEnv = process.env.AGENT_HTTP_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const port = Number(process.env.AGENT_HTTP_PORT ?? "18998");
  const p = Number.isFinite(port) && port > 0 ? Math.floor(port) : 18998;
  return `http://127.0.0.1:${p}`;
}

function resolveToken(explicit?: string): string | undefined {
  const t =
    explicit?.trim() ||
    process.env.AGENT_HTTP_TOKEN?.trim() ||
    process.env.AGENT_HTTP_TOKEN?.trim();
  return t || undefined;
}

function parseErrorMessage(status: number, text: string, body: unknown): string {
  if (body && typeof body === "object" && "message" in body) {
    const m = (body as { message: unknown }).message;
    if (typeof m === "string" && m.trim()) return m;
  }
  const slice = text.trim().slice(0, 500);
  return slice || `HTTP ${status}`;
}

async function postInstallOrUninstall(
  command: InstallAppCommand | UninstallAppCommand,
  opts: AgentHttpClientOptions,
): Promise<void> {
  const baseUrl = resolveBaseUrl(opts.baseUrl);
  const token = resolveToken(opts.token);
  const url = `${baseUrl}/platform/commands`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await (opts.fetchImpl ?? globalThis.fetch)(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ command }),
    signal: opts.signal,
  });

  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }

  if (res.ok) return;
  throw new AgentHttpCommandError(parseErrorMessage(res.status, text, body), res.status, body);
}

/**
 * 经 Agent HTTP 同步安装应用（服务端会等到 adb/ideviceinstaller/hdc 结束再响应）。
 * 须已占用对应 `resourceId` 的租约（或依赖 Agent 侧自动租约配置）。
 */
export async function installAppOnAgent(
  params: { resourceId: string; appRef: string } & AgentHttpClientOptions,
): Promise<void> {
  const { resourceId, appRef, baseUrl, token, signal, fetchImpl } = params;
  const command: InstallAppCommand = {
    type: "InstallAppCommand",
    resourceId,
    appRef,
  };
  await postInstallOrUninstall(command, { baseUrl, token, signal, fetchImpl });
}

/**
 * 经 Agent HTTP 同步卸载应用。
 */
export async function uninstallAppOnAgent(
  params: { resourceId: string; bundleId: string } & AgentHttpClientOptions,
): Promise<void> {
  const { resourceId, bundleId, baseUrl, token, signal, fetchImpl } = params;
  const command: UninstallAppCommand = {
    type: "UninstallAppCommand",
    resourceId,
    bundleId,
  };
  await postInstallOrUninstall(command, { baseUrl, token, signal, fetchImpl });
}
