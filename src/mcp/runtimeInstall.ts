import { spawn } from "node:child_process";
import { access, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

export interface RuntimeInstallOptions {
  sourceRoot?: string;
  targetProjectRoot?: string;
  projectRoot?: string;
  runtimeRoot?: string;
  runNpm?: (args: string[], cwd: string) => Promise<void>;
}

export interface RuntimeInstallResult {
  runtimeRoot: string;
  nodeBin: string;
  mcpEntry: string;
}

export async function installLocalRuntime(options: RuntimeInstallOptions): Promise<RuntimeInstallResult> {
  const runtimeRoot = options.runtimeRoot ?? join(homedir(), ".preflight", "runtime");
  const sourceRoot = options.sourceRoot ?? options.projectRoot;
  const targetProjectRoot = options.targetProjectRoot ?? options.projectRoot ?? process.cwd();
  const npmRunner = options.runNpm ?? runNpm;
  if (!sourceRoot) {
    throw new Error("Preflight runtime source root is required.");
  }
  if (await exists(join(sourceRoot, "tsconfig.build.json"))) {
    await npmRunner(["run", "build"], sourceRoot);
  }

  await rm(runtimeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(join(runtimeRoot, "node", "bin"), { recursive: true });

  await cp(process.execPath, join(runtimeRoot, "node", "bin", "node"));
  await cp(join(sourceRoot, "dist"), join(runtimeRoot, "dist"), { recursive: true });
  await cp(join(sourceRoot, "package.json"), join(runtimeRoot, "package.json"));
  await cp(join(sourceRoot, "package-lock.json"), join(runtimeRoot, "package-lock.json")).catch(() => {});
  await cp(join(sourceRoot, "scripts"), join(runtimeRoot, "scripts"), { recursive: true }).catch(() => {});
  await mkdir(join(runtimeRoot, "docs"), { recursive: true });
  await cp(join(sourceRoot, "docs", "visual-flow-ir-llm.md"), join(runtimeRoot, "docs", "visual-flow-ir-llm.md"));

  const reusedDependencies = await reuseInstalledDependencies(sourceRoot, runtimeRoot);
  if (!reusedDependencies) {
    await npmRunner(await exists(join(runtimeRoot, "package-lock.json")) ? ["ci", "--omit=dev"] : ["install", "--omit=dev"], runtimeRoot);
  }
  await writeFile(
    join(runtimeRoot, "preflight-runtime.json"),
    `${JSON.stringify({ installedAt: new Date().toISOString(), source: sourceRoot, targetProjectRoot }, null, 2)}\n`,
    "utf8",
  );

  return {
    runtimeRoot,
    nodeBin: join(runtimeRoot, "node", "bin", "node"),
    mcpEntry: join(runtimeRoot, "dist", "mcp", "cli.js"),
  };
}

async function reuseInstalledDependencies(sourceRoot: string, runtimeRoot: string): Promise<boolean> {
  const packageNodeModules = join(sourceRoot, "node_modules");
  if (await exists(packageNodeModules)) {
    await cp(packageNodeModules, join(runtimeRoot, "node_modules"), { recursive: true });
    return true;
  }

  const parentNodeModules = dirname(sourceRoot);
  const isNpxPackage = basename(parentNodeModules) === "node_modules" && parentNodeModules.includes(`${sep}_npx${sep}`);
  if (isNpxPackage) {
    await cp(parentNodeModules, join(runtimeRoot, "node_modules"), { recursive: true });
    return true;
  }

  return false;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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
