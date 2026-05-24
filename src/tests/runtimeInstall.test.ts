import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { installLocalRuntime } from "../mcp/runtimeInstall.ts";

test("installs runtime from package root without building the target project", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "preflite-runtime-install-"));
  const sourceRoot = join(root, "preflite-package");
  const targetProjectRoot = join(root, "user-project");
  const runtimeRoot = join(root, "runtime");
  const npmCalls: Array<{ args: string[]; cwd: string }> = [];

  await mkdir(join(sourceRoot, "dist", "mcp"), { recursive: true });
  await mkdir(join(sourceRoot, "docs"), { recursive: true });
  await mkdir(join(sourceRoot, "scripts"), { recursive: true });
  await mkdir(targetProjectRoot, { recursive: true });
  await writeFile(join(sourceRoot, "dist", "mcp", "cli.js"), "console.log('runtime');\n");
  await writeFile(join(sourceRoot, "docs", "visual-flow-ir-llm.md"), "# IR rules\n");
  await writeFile(join(sourceRoot, "package.json"), JSON.stringify({ name: "preflite", dependencies: {} }));
  await writeFile(join(targetProjectRoot, "package.json"), JSON.stringify({ name: "app-without-build" }));

  await installLocalRuntime({
    sourceRoot,
    targetProjectRoot,
    runtimeRoot,
    runNpm: async (args, cwd) => {
      npmCalls.push({ args, cwd });
    },
  });

  assert.equal(await readFile(join(runtimeRoot, "dist", "mcp", "cli.js"), "utf8"), "console.log('runtime');\n");
  assert.deepEqual(npmCalls, [{ args: ["install", "--omit=dev"], cwd: runtimeRoot }]);
});

test("reuses npx-installed dependencies instead of running npm install again", async () => {
  const root = await mkdtemp(join(tmpdir(), "preflite-runtime-npx-"));
  const npxNodeModules = join(root, "_npx", "hash", "node_modules");
  const sourceRoot = join(npxNodeModules, "preflite");
  const runtimeRoot = join(root, "runtime");
  const npmCalls: Array<{ args: string[]; cwd: string }> = [];

  await mkdir(join(sourceRoot, "dist", "mcp"), { recursive: true });
  await mkdir(join(sourceRoot, "docs"), { recursive: true });
  await mkdir(join(npxNodeModules, "preflite-dependency"), { recursive: true });
  await writeFile(join(sourceRoot, "dist", "mcp", "cli.js"), "console.log('runtime');\n");
  await writeFile(join(sourceRoot, "docs", "visual-flow-ir-llm.md"), "# IR rules\n");
  await writeFile(join(sourceRoot, "package.json"), JSON.stringify({ name: "preflite", dependencies: {} }));
  await writeFile(join(npxNodeModules, "preflite-dependency", "index.js"), "export {};\n");

  await installLocalRuntime({
    sourceRoot,
    targetProjectRoot: join(root, "user-project"),
    runtimeRoot,
    runNpm: async (args, cwd) => {
      npmCalls.push({ args, cwd });
    },
  });

  assert.equal(await readFile(join(runtimeRoot, "node_modules", "preflite-dependency", "index.js"), "utf8"), "export {};\n");
  assert.deepEqual(npmCalls, []);
});
