import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentHttpClient } from "./agentHttpClient.js";
import type { AgentHealth } from "./types.js";

export interface AgentRuntimeStatus {
  ok: boolean;
  state: "running" | "started" | "starting" | "stopped" | "failed";
  message: string;
  pid?: number;
  health?: AgentHealth;
  logPath: string;
  pidPath: string;
  baseUrl: string;
}

export interface AgentRuntimeManagerOptions {
  /** 开发模式工作根目录（用于查找 src/main.ts） */
  projectRoot: string;
  agentBaseUrl: string;
  client: AgentHttpClient;
  env?: NodeJS.ProcessEnv;
  /** Runtime 模式根目录。设置后用 runtime 内的 node+dist 启动 agent，无需 source 仓库。 */
  runtimeRoot?: string;
  loadConfigEnv?: () => Promise<Record<string, string>>;
}

export class AgentRuntimeManager {
  private child?: ChildProcess;
  private logStream?: WriteStream;
  private startPromise?: Promise<AgentRuntimeStatus>;

  readonly logPath: string;
  readonly pidPath: string;
  private readonly runtimeRoot?: string;
  private readonly preflightHome: string;

  constructor(private readonly options: AgentRuntimeManagerOptions) {
    this.runtimeRoot = options.runtimeRoot ?? (process.env.AGENT_RUNTIME_ROOT?.trim() || undefined);
    this.preflightHome = process.env.PREFLIGHT_HOME?.trim() || join(homedir(), ".preflight");
    this.logPath = join(this.preflightHome, "runtime", "agent.log");
    this.pidPath = join(this.preflightHome, "runtime", "agent.pid");
  }

  /** 运行模式 */
  get mode(): "dev" | "runtime" {
    return this.runtimeRoot ? "runtime" : "dev";
  }

  async status(): Promise<AgentRuntimeStatus> {
    const health = await this.options.client.health();
    if (health.ok) {
      return {
        ok: true,
        state: "running",
        message: "automation-agent HTTP is reachable.",
        pid: this.child?.pid ?? (await this.readPid()),
        health,
        logPath: this.logPath,
        pidPath: this.pidPath,
        baseUrl: this.options.agentBaseUrl,
      };
    }
    return {
      ok: false,
      state: "stopped",
      message: `automation-agent HTTP is not reachable: ${health.error ?? "unknown error"}`,
      pid: this.child?.pid ?? (await this.readPid()),
      health,
      logPath: this.logPath,
      pidPath: this.pidPath,
      baseUrl: this.options.agentBaseUrl,
    };
  }

  async ensureStarted(): Promise<AgentRuntimeStatus> {
    const current = await this.status();
    if (current.ok) return current;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  async stop(): Promise<AgentRuntimeStatus> {
    if (!this.child || this.child.killed) {
      return this.status();
    }
    const pid = this.child.pid;
    this.child.kill("SIGTERM");
    await delay(500);
    const health = await this.options.client.health();
    return {
      ok: !health.ok,
      state: health.ok ? "running" : "stopped",
      message: health.ok ? "automation-agent is still reachable after SIGTERM." : "automation-agent stopped.",
      pid,
      health,
      logPath: this.logPath,
      pidPath: this.pidPath,
      baseUrl: this.options.agentBaseUrl,
    };
  }

  private async start(): Promise<AgentRuntimeStatus> {
    await mkdir(dirname(this.logPath), { recursive: true });
    this.logStream = createWriteStream(this.logPath, { flags: "a" });
    this.logStream.write(`\n[preflight-mcp] starting automation-agent (${this.mode} mode) at ${new Date().toISOString()}\n`);

    const port = portFromBaseUrl(this.options.agentBaseUrl) ?? 18998;
    const configEnv = (await this.options.loadConfigEnv?.()) ?? {};
    const env = {
      ...(this.options.env ?? process.env),
      ...configEnv,
      LOCAL_MCP_MODE: "1",
      PREFLIGHT_HOME: this.preflightHome,
      AGENT_HOME: this.preflightHome,
      AGENT_HTTP_PORT: String(port),
      AGENT_HTTP_TOKEN: "",
      PLATFORM_WS_TOKEN: "",
      PLATFORM_AGENT_CALLBACK_TOKEN: "",
      PLATFORM_CALLBACK_ENDPOINT: "",
      PLATFORM_COMMAND_POLL_BASE_URL: "",
      MCP_AGENT_AUTOSTART: "1",
    };

    if (this.runtimeRoot) {
      // Runtime 模式：使用打包后的 node + dist
      const nodeBin = join(this.runtimeRoot, "node", "bin", "node");
      const entry = join(this.runtimeRoot, "dist", "main.js");
      this.logStream.write(`[preflight-mcp] runtimeRoot=${this.runtimeRoot} node=${nodeBin} entry=${entry}\n`);
      this.child = spawn(nodeBin, [entry], {
        cwd: this.runtimeRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } else {
      // 开发模式：使用 npm exec tsx
      this.child = spawn("npm", ["--silent", "--prefix", this.options.projectRoot, "exec", "tsx", "src/main.ts"], {
        cwd: this.options.projectRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }

    this.child.stdout?.pipe(this.logStream, { end: false });
    this.child.stderr?.pipe(this.logStream, { end: false });
    this.child.on("exit", (code, signal) => {
      this.logStream?.write(`[preflight-mcp] automation-agent exited code=${code ?? ""} signal=${signal ?? ""}\n`);
    });
    if (this.child.pid) {
      await writeFile(this.pidPath, `${this.child.pid}\n`, "utf8");
    }

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const health = await this.options.client.health();
      if (health.ok) {
        return {
          ok: true,
          state: "started",
          message: "automation-agent started and HTTP is reachable.",
          pid: this.child.pid,
          health,
          logPath: this.logPath,
          pidPath: this.pidPath,
          baseUrl: this.options.agentBaseUrl,
        };
      }
      if (this.child.exitCode !== null) break;
      await delay(500);
    }

    const health = await this.options.client.health();
    return {
      ok: false,
      state: "failed",
      message: `automation-agent did not become ready in ${this.mode} mode. Check logPath: ${this.logPath}`,
      pid: this.child.pid,
      health,
      logPath: this.logPath,
      pidPath: this.pidPath,
      baseUrl: this.options.agentBaseUrl,
    };
  }

  private async readPid(): Promise<number | undefined> {
    try {
      const text = await readFile(this.pidPath, "utf8");
      const pid = Number(text.trim());
      return Number.isFinite(pid) && pid > 0 ? Math.floor(pid) : undefined;
    } catch {
      return undefined;
    }
  }
}

function portFromBaseUrl(baseUrl: string): number | undefined {
  try {
    const port = Number(new URL(baseUrl).port);
    return Number.isFinite(port) && port > 0 ? Math.floor(port) : undefined;
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
