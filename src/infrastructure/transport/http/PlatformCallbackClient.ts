export interface PlatformCallbackClientOptions {
  endpoint?: string;
  authToken?: string;
}

export type TaskLogCallbackPayload = {
  agentId: string;
  chunk: string;
  /** 单调递增，便于去重/排序 */
  seq?: number;
  isFinal?: boolean;
  stream?: "stdout" | "stderr" | "mixed";
};

export type TaskReportAssetFile = {
  relativePath: string;
  base64: string;
};

export type TaskReportCallbackPayload = {
  agentId: string;
  reportHtml: string;
  reportName?: string;
  reportFormat?: "single-html" | "html-and-external-assets";
  partial?: boolean;
  /** 目录模式整包（zip）的 base64，体积大时慎用 */
  reportBundleBase64?: string;
  executionDumpJson?: string;
  executionDumpRevision?: number;
  reportAssetFiles?: TaskReportAssetFile[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 单次请求超时（毫秒）；大报告体可调大 */
function callbackHttpTimeoutMs(): number {
  const raw = Number(process.env.PLATFORM_CALLBACK_HTTP_TIMEOUT_MS ?? "120000");
  return Number.isFinite(raw) && raw >= 5000 ? Math.floor(raw) : 120000;
}

/** 同一请求内失败后的最大尝试次数（含首次） */
function callbackMaxAttempts(): number {
  const raw = Number(process.env.PLATFORM_CALLBACK_HTTP_MAX_ATTEMPTS ?? "3");
  const n = Math.floor(raw);
  return n >= 1 && n <= 10 ? n : 3;
}

/** 重试基础间隔（毫秒），实际为指数退避：base * 2^attempt */
function callbackRetryBaseMs(): number {
  const raw = Number(process.env.PLATFORM_CALLBACK_HTTP_RETRY_BASE_MS ?? "500");
  return Number.isFinite(raw) && raw >= 50 ? Math.floor(raw) : 500;
}

function shouldRetryHttpStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  if (status >= 500 && status <= 504) return true;
  return false;
}

/** 平台回调 HTTP 404（如 unknown agent task id）：无需再重试或保留 Outbox */
export function isCallbackNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\bcallback failed: 404\b/.test(msg);
}

export class PlatformCallbackClient {
  private readonly endpoint?: string;
  private readonly authToken?: string;

  constructor(options: PlatformCallbackClientOptions) {
    this.endpoint = options.endpoint?.trim() || undefined;
    this.authToken = options.authToken?.trim() || undefined;
  }

  private async post(path: string, body: Record<string, unknown>): Promise<void> {
    if (!this.endpoint) return;
    const url = `${this.endpoint.replace(/\/+$/, "")}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;
    const timeoutMs = callbackHttpTimeoutMs();
    const maxAttempts = callbackMaxAttempts();
    const baseMs = callbackRetryBaseMs();

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
        });

        if (resp.ok) return;

        const snippet = await resp.text().catch(() => "");
        const status = resp.status;
        const hint =
          status === 401
            ? "（请核对平台生成的 Token 与 Agent 侧 AGENT_HTTP_TOKEN 一致；PLATFORM_WS_TOKEN / PLATFORM_AGENT_CALLBACK_TOKEN 未填时会复用 AGENT_HTTP_TOKEN）"
            : status === 503
              ? "（平台未配置回调鉴权 token）"
              : "";
        console.warn(
          `[PlatformCallback] POST ${path} -> ${status}${hint}${snippet ? ` body=${snippet.slice(0, 200)}` : ""}`,
        );

        if (!shouldRetryHttpStatus(status)) {
          throw new Error(`callback failed: ${status}`);
        }

        if (attempt < maxAttempts - 1) {
          const wait = baseMs * 2 ** attempt;
          console.warn(
            `[PlatformCallback] POST ${path} HTTP ${status} 可重试，${wait}ms 后进行第 ${attempt + 2}/${maxAttempts} 次尝试`,
          );
          await sleep(wait);
          continue;
        }

        throw new Error(`callback failed: ${status}`);
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));

        const hf = /^callback failed: (\d+)$/.exec(err.message);
        if (hf) {
          const code = Number(hf[1]);
          if (!shouldRetryHttpStatus(code)) throw err;
          if (attempt >= maxAttempts - 1) throw err;
        }

        const transient =
          err.name === "AbortError" ||
          err.name === "TimeoutError" ||
          /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT/i.test(err.message);

        if (!transient) throw err;

        if (attempt >= maxAttempts - 1) throw err;

        const wait = baseMs * 2 ** attempt;
        console.warn(
          `[PlatformCallback] POST ${path} 传输失败 (${err.message})，${wait}ms 后重试 (${attempt + 2}/${maxAttempts})`,
        );
        await sleep(wait);
      }
    }
  }

  async pushTaskStatus(taskId: string, payload: { agentId: string; status: string; message?: string }): Promise<void> {
    await this.post(`/api/agent/callbacks/tasks/${encodeURIComponent(taskId)}/status`, payload);
  }

  async pushTaskLog(taskId: string, payload: TaskLogCallbackPayload): Promise<void> {
    await this.post(`/api/agent/callbacks/tasks/${encodeURIComponent(taskId)}/log`, { ...payload, taskId });
  }

  async pushTaskReport(taskId: string, payload: TaskReportCallbackPayload): Promise<void> {
    await this.post(`/api/agent/callbacks/tasks/${encodeURIComponent(taskId)}/report`, { ...payload, taskId });
  }
}
