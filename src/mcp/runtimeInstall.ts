import { spawn } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RuntimeInstallOptions {
  projectRoot: string;
  runtimeRoot?: string;
}

export interface RuntimeInstallResult {
  runtimeRoot: string;
  nodeBin: string;
  mcpEntry: string;
}

export async function installLocalRuntime(options: RuntimeInstallOptions): Promise<RuntimeInstallResult> {
  const runtimeRoot = options.runtimeRoot ?? join(homedir(), ".preflight", "runtime");
  await runNpm(["run", "build"], options.projectRoot);

  await rm(runtimeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(join(runtimeRoot, "node", "bin"), { recursive: true });

  await cp(process.execPath, join(runtimeRoot, "node", "bin", "node"));
  await cp(join(options.projectRoot, "dist"), join(runtimeRoot, "dist"), { recursive: true });
  await cp(join(options.projectRoot, "package.json"), join(runtimeRoot, "package.json"));
  await cp(join(options.projectRoot, "package-lock.json"), join(runtimeRoot, "package-lock.json"));
  await cp(join(options.projectRoot, "scripts"), join(runtimeRoot, "scripts"), { recursive: true }).catch(() => {});
  await mkdir(join(runtimeRoot, "docs"), { recursive: true });
  await cp(join(options.projectRoot, "docs", "visual-flow-ir-llm.md"), join(runtimeRoot, "docs", "visual-flow-ir-llm.md"));

  await runNpm(["ci", "--omit=dev"], runtimeRoot);
  await writeFile(
    join(runtimeRoot, "preflight-runtime.json"),
    `${JSON.stringify({ installedAt: new Date().toISOString(), source: options.projectRoot }, null, 2)}\n`,
    "utf8",
  );

  return {
    runtimeRoot,
    nodeBin: join(runtimeRoot, "node", "bin", "node"),
    mcpEntry: join(runtimeRoot, "dist", "mcp", "cli.js"),
  };
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code ?? "unknown"}`));
    });
  });
}

function runNpm(args: string[], cwd: string): Promise<void> {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return run(process.execPath, [npmExecPath, ...args], cwd);
  }
  return run("npm", args, cwd);
}
