import type {
  AgentArtifact,
  AgentEventSnapshot,
  AgentHealth,
  AgentHttpConfig,
  AgentResource,
  AgentTask,
} from "./types.js";

export class AgentHttpClient {
  constructor(private readonly config: AgentHttpConfig) {}

  async health(): Promise<AgentHealth> {
    try {
      const raw = await this.getJson("/health");
      return { ok: true, raw };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async listDevices(): Promise<AgentResource[]> {
    return this.getJson<AgentResource[]>("/resources");
  }

  async installApp(resourceId: string, appRef: string): Promise<unknown> {
    return this.postCommand({
      type: "InstallAppCommand",
      resourceId,
      appRef,
    });
  }

  async createTask(input: {
    taskId: string;
    requiredPlatform: string;
    script: string;
    scriptKind?: "midscene" | "airtest";
    resourceId?: string;
    runtimeEnv?: Record<string, string>;
  }): Promise<unknown> {
    return this.postCommand({
      type: "CreateTaskCommand",
      taskId: input.taskId,
      requiredPlatform: input.requiredPlatform,
      script: input.script,
      scriptKind: input.scriptKind,
      resourceId: input.resourceId,
      runtimeEnv: input.runtimeEnv,
    });
  }

  async getTask(taskId: string): Promise<AgentTask | undefined> {
    try {
      return await this.getJson<AgentTask>(`/tasks/${encodeURIComponent(taskId)}`);
    } catch (error) {
      if (error instanceof AgentHttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  async listEvents(taskId: string, limit = 100): Promise<AgentEventSnapshot[]> {
    return this.getJson<AgentEventSnapshot[]>(
      `/events?taskId=${encodeURIComponent(taskId)}&limit=${encodeURIComponent(String(limit))}`,
    );
  }

  async listArtifacts(taskId: string): Promise<AgentArtifact[]> {
    return this.getJson<AgentArtifact[]>(`/artifacts?taskId=${encodeURIComponent(taskId)}`);
  }

  private async postCommand(command: Record<string, unknown>): Promise<unknown> {
    return this.fetchJson("/platform/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ deliveryId: `mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`, command }),
    });
  }

  private async getJson<T = unknown>(path: string): Promise<T> {
    return this.fetchJson<T>(path, { method: "GET" });
  }

  private async fetchJson<T = unknown>(path: string, init: RequestInit): Promise<T> {
    const url = new URL(path, this.config.baseUrl);
    const headers = new Headers(init.headers);
    if (this.config.token) headers.set("Authorization", `Bearer ${this.config.token}`);
    const resp = await fetch(url, { ...init, headers });
    const text = await resp.text();
    const body = text ? JSON.parse(text) : null;
    if (!resp.ok) {
      throw new AgentHttpError(resp.status, body && typeof body === "object" ? JSON.stringify(body) : text);
    }
    return body as T;
  }
}

export class AgentHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`Agent HTTP ${status}: ${message}`);
  }
}
