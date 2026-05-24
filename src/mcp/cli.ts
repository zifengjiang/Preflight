#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPreflightMcpServer } from "./server.js";
import { setupLocalMcp } from "./setup.js";

// Prevent unhandled rejections / exceptions from crashing the server mid-session
process.on("unhandledRejection", (reason) => {
  console.error("[Preflight-MCP] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[Preflight-MCP] uncaughtException:", err);
});

const command = process.argv[2] ?? "serve";

if (command === "serve") {
  const runtimeRoot = argValue("--runtime-root") ?? (process.env.AGENT_RUNTIME_ROOT?.trim() || undefined);
  const server = createPreflightMcpServer({ runtimeRoot });
  await server.connect(new StdioServerTransport());
} else if (command === "setup") {
  const projectRoot = argValue("--project-root") ?? process.cwd();
  const runtimeSourceRoot = argValue("--runtime-source-root") ?? await findPackageRoot();
  const agentBaseUrl = argValue("--agent-base-url") ?? process.env.AGENT_BASE_URL ?? "http://127.0.0.1:18998";
  const livePort = Number(argValue("--live-port") ?? process.env.MCP_LIVE_PORT ?? "18999");
  const runtimeRoot = argValue("--runtime-root") ?? process.env.AGENT_RUNTIME_ROOT?.trim() ?? undefined;
  const installRuntime = !process.argv.includes("--no-install-runtime");
  const result = await setupLocalMcp({ projectRoot, runtimeSourceRoot, agentBaseUrl, livePort, runtimeRoot, installRuntime });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
} else {
  console.error(`Unknown Preflight MCP command: ${command}`);
  process.exitCode = 2;
}

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

async function findPackageRoot(): Promise<string> {
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (await exists(join(current, "package.json"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("Could not locate the preflite package root.");
    }
    current = parent;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
