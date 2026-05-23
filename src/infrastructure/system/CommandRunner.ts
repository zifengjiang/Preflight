import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

export interface CommandRunResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunOptions {
  env?: Record<string, string>;
  /** 子进程 stdout 增量（与最终 result.stdout 内容一致，便于边跑边回传） */
  onStdoutChunk?: (text: string) => void;
  onStderrChunk?: (text: string) => void;
}

export interface CommandRunner {
  run(command: string, timeoutMs?: number, signal?: AbortSignal, options?: CommandRunOptions): Promise<CommandRunResult>;
}

/**
 * 在子进程 PATH 前插入常见 CLI 目录（adb / ideviceinfo / brew 等），避免 GUI/Cursor 启动的 Node
 * 未继承 zsh PATH 时找不到命令。最前可由 `AGENT_EXTRA_PATH` 或 `AUTOMATION_AGENT_EXTRA_PATH` 覆盖（与 OS 相同的 PATH 分隔符）。
 * 若 `options.env` 显式传入 `PATH`，则不再改写，由调用方完全控制。
 */
export function augmentPathForShellCommands(basePath: string | undefined): string {
  const sep = path.delimiter;
  const extraEnv = process.env.AGENT_EXTRA_PATH?.trim() || process.env.AUTOMATION_AGENT_EXTRA_PATH?.trim();
  const customHead = extraEnv
    ? extraEnv
        .split(sep)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const home = homedir();
  const sdkRoot = process.env.ANDROID_HOME?.trim() || process.env.ANDROID_SDK_ROOT?.trim();
  const prepend: string[] = [
    ...customHead,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...(sdkRoot ? [path.join(sdkRoot, "platform-tools")] : []),
    path.join(home, "Library/Android/sdk/platform-tools"),
    "/usr/bin",
    "/bin",
  ];
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const p of prepend) {
    const n = path.normalize(p);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    ordered.push(n);
  }
  for (const p of (basePath ?? "").split(sep)) {
    const n = p.trim();
    if (!n) continue;
    const norm = path.normalize(n);
    if (seen.has(norm)) continue;
    seen.add(norm);
    ordered.push(n);
  }
  return ordered.join(sep);
}

export class NodeCommandRunner implements CommandRunner {
  async run(
    command: string,
    timeoutMs = 60_000,
    signal?: AbortSignal,
    options?: CommandRunOptions,
  ): Promise<CommandRunResult> {
    return new Promise<CommandRunResult>((resolve) => {
      const optEnv = options?.env ?? {};
      const merged: Record<string, string | undefined> = {
        ...process.env,
        ...optEnv,
      };
      if (!("PATH" in optEnv)) {
        merged.PATH = augmentPathForShellCommands(process.env.PATH);
      }
      const child = spawn("sh", ["-lc", command], {
        stdio: ["ignore", "pipe", "pipe"],
        env: merged as NodeJS.ProcessEnv,
      });
      let stdout = "";
      let stderr = "";
      let killedByTimeout = false;
      let killedByAbort = false;
      const timer = setTimeout(() => {
        killedByTimeout = true;
        child.kill("SIGTERM");
      }, timeoutMs);
      const abortHandler = () => {
        killedByAbort = true;
        child.kill("SIGTERM");
      };
      signal?.addEventListener("abort", abortHandler, { once: true });

      child.stdout.on("data", (chunk) => {
        const t = chunk.toString();
        stdout += t;
        options?.onStdoutChunk?.(t);
      });
      child.stderr.on("data", (chunk) => {
        const t = chunk.toString();
        stderr += t;
        options?.onStderrChunk?.(t);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abortHandler);
        if (killedByAbort) {
          resolve({
            ok: false,
            exitCode: -1,
            stdout,
            stderr: `${stderr}\ncommand cancelled`,
          });
          return;
        }
        if (killedByTimeout) {
          resolve({
            ok: false,
            exitCode: -1,
            stdout,
            stderr: `${stderr}\ncommand timeout after ${timeoutMs}ms`,
          });
          return;
        }
        resolve({
          ok: code === 0,
          exitCode: code ?? -1,
          stdout,
          stderr,
        });
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abortHandler);
        resolve({
          ok: false,
          exitCode: -1,
          stdout,
          stderr: `${stderr}\n${error.message}`,
        });
      });
    });
  }
}
