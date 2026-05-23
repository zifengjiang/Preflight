#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
  const agentBaseUrl = argValue("--agent-base-url") ?? process.env.AGENT_BASE_URL ?? "http://127.0.0.1:18998";
  const livePort = Number(argValue("--live-port") ?? process.env.MCP_LIVE_PORT ?? "18999");
  const runtimeRoot = argValue("--runtime-root") ?? process.env.AGENT_RUNTIME_ROOT?.trim() ?? undefined;
  const installRuntime = !process.argv.includes("--no-install-runtime");
  const result = await setupLocalMcp({ projectRoot, agentBaseUrl, livePort, runtimeRoot, installRuntime });
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
