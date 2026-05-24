import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { installLocalRuntime } from "./runtimeInstall.js";

export interface SetupOptions {
  projectRoot: string;
  runtimeSourceRoot?: string;
  agentBaseUrl?: string;
  livePort?: number;
  installRuntime?: boolean;
  runtimeRoot?: string;
}

export interface SetupResult {
  cursorConfigPath: string;
  cursorRulePath: string;
  codexConfigPath: string;
  skillPath: string;
  codexSkillPath: string;
  agentsSkillPath: string;
  runtimeRoot?: string;
  userConfigExamplePath: string;
}

export async function setupLocalMcp(options: SetupOptions): Promise<SetupResult> {
  const agentBaseUrl = options.agentBaseUrl ?? "http://127.0.0.1:18998";
  const livePort = options.livePort ?? 18999;
  const shouldInstallRuntime = options.installRuntime ?? true;
  const installedRuntime = shouldInstallRuntime
    ? await installLocalRuntime({
        sourceRoot: options.runtimeSourceRoot ?? options.projectRoot,
        targetProjectRoot: options.projectRoot,
        runtimeRoot: options.runtimeRoot,
      })
    : undefined;
  const runtimeRoot = installedRuntime?.runtimeRoot ?? options.runtimeRoot ?? process.env.AGENT_RUNTIME_ROOT?.trim();
  const isRuntime = !!runtimeRoot;
  const cursorConfigPath = join(options.projectRoot, ".cursor", "mcp.json");
  const cursorRulePath = join(options.projectRoot, ".cursor", "rules", "preflight.mdc");
  const skillPath = join(options.projectRoot, ".preflight", "skills", "preflight.md");
  const codexSkillPath = join(homedir(), ".codex", "skills", "preflight", "SKILL.md");
  const agentsSkillPath = join(homedir(), ".agents", "skills", "preflight", "SKILL.md");
  const userConfigExamplePath = join(homedir(), ".preflight", "config.example.json");
  const codexConfigPath = join(homedir(), ".codex", "config.toml");

  await writeCursorMcpConfig(cursorConfigPath, options.projectRoot, agentBaseUrl, livePort, isRuntime, runtimeRoot);
  await writeTextFile(cursorRulePath, cursorRuleText());
  await writeTextFile(skillPath, skillText());
  await writeTextFile(codexSkillPath, skillText());
  await writeTextFile(agentsSkillPath, skillText());
  await writeTextFile(userConfigExamplePath, userConfigExampleText());
  await upsertCodexMcpConfig(codexConfigPath, options.projectRoot, agentBaseUrl, livePort, isRuntime, runtimeRoot);

  return { cursorConfigPath, cursorRulePath, codexConfigPath, skillPath, codexSkillPath, agentsSkillPath, runtimeRoot, userConfigExamplePath };
}

async function writeCursorMcpConfig(path: string, projectRoot: string, agentBaseUrl: string, livePort: number, isRuntime: boolean, runtimeRoot?: string): Promise<void> {
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    existing = {};
  }
  const mcpServers =
    typeof existing.mcpServers === "object" && existing.mcpServers
      ? { ...(existing.mcpServers as Record<string, unknown>) }
      : {};
  delete mcpServers["Preflight"];
  if (isRuntime && runtimeRoot) {
    const nodeBin = join(runtimeRoot, "node", "bin", "node");
    const mcpEntry = join(runtimeRoot, "dist", "mcp", "cli.js");
    existing.mcpServers = {
      ...mcpServers,
      "Preflight": {
        command: nodeBin,
        args: [mcpEntry, "serve"],
        env: {
          AGENT_RUNTIME_ROOT: runtimeRoot,
          AGENT_BASE_URL: agentBaseUrl,
          MCP_LIVE_PORT: String(livePort),
          PREFLIGHT_HOME: join(homedir(), ".preflight"),
        },
      },
    };
  } else {
    existing.mcpServers = {
      ...mcpServers,
      "Preflight": {
        command: "npm",
        args: ["--silent", "--prefix", projectRoot, "run", "mcp", "--", "serve"],
        env: {
          PROJECT_ROOT: projectRoot,
          AGENT_BASE_URL: agentBaseUrl,
          MCP_LIVE_PORT: String(livePort),
          PREFLIGHT_HOME: join(homedir(), ".preflight"),
        },
      },
    };
  }
  await writeTextFile(path, `${JSON.stringify(existing, null, 2)}\n`);
}

async function upsertCodexMcpConfig(path: string, projectRoot: string, agentBaseUrl: string, livePort: number, isRuntime: boolean, runtimeRoot?: string): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch {
    existing = "";
  }
  await writeTextFile(path, mergeCodexMcpConfig(existing, projectRoot, agentBaseUrl, livePort, isRuntime, runtimeRoot));
}

export function mergeCodexMcpConfig(existing: string, projectRoot: string, agentBaseUrl: string, livePort: number, isRuntime = false, runtimeRoot?: string): string {
  const block = isRuntime && runtimeRoot
    ? `[mcp_servers.Preflight]
command = ${tomlString(join(runtimeRoot, "node", "bin", "node"))}
args = [${tomlString(join(runtimeRoot, "dist", "mcp", "cli.js"))}, "serve"]
env = { AGENT_RUNTIME_ROOT = ${tomlString(runtimeRoot)}, AGENT_BASE_URL = ${tomlString(agentBaseUrl)}, MCP_LIVE_PORT = ${tomlString(String(livePort))}, PREFLIGHT_HOME = ${tomlString(join(homedir(), ".preflight"))} }
`
    : `[mcp_servers.Preflight]
command = "npm"
args = ["--silent", "--prefix", ${tomlString(projectRoot)}, "run", "mcp", "--", "serve"]
env = { PROJECT_ROOT = ${tomlString(projectRoot)}, AGENT_BASE_URL = ${tomlString(agentBaseUrl)}, MCP_LIVE_PORT = ${tomlString(String(livePort))}, PREFLIGHT_HOME = ${tomlString(join(homedir(), ".preflight"))} }
`;
  const withoutOld = existing
    .replace(/(?:^|\n)\[mcp_servers\.Preflight\]\n(?:(?!\[).*(?:\n|$))*/g, "\n")
    .trimEnd();
  return `${withoutOld}${withoutOld ? "\n\n" : ""}${block}`;
}

async function writeTextFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function cursorRuleText(): string {
  return `---
description: 使用本机 Preflight MCP 做移动端测试
alwaysApply: false
---

当用户要求"测试""跑一下这次的改动"时：

0. 必须先确认 Preflight MCP 工具已经注入当前会话。若看不到 \`doctor\`、\`list_devices\` 等工具，立即停止并提示用户重启 Codex/Cursor 或检查 MCP 配置；不要改用 shell、curl、npm script、读取本仓库源码等方式模拟 MCP。
1. 只在用户当前项目中读取 git diff，总结本次改动影响的页面、流程、平台和风险点。
2. 调用 \`start_agent\` 或 \`doctor\`；MCP 会自动拉起本地 automation-agent，不需要用户手动执行 \`npm run dev\`，也不需要 test-service/platform。
3. 如果 Midscene API key 这类阻塞项失败，先把阻塞项说清楚，不要继续跑；如果 ffmpeg 或 scrcpy 缺失，说明本次不会生成 Android 操作录屏；\`AGENT_HTTP_TOKEN\` 不是本地 MCP 必填项。
4. 如需确认配置来源，调用 \`config_status\`；模型 API key 应放在 \`~/.preflight/config.json\` 或 \`~/.preflight/config.yaml\`，不要写进 MCP 配置环境变量。
5. 调用 \`list_devices\`，优先选择与改动相关的平台设备。
6. 调用 \`get_visual_flow_ir_rules\`，按 IR 规范生成 visualFlow JSON。默认不要直接写 Midscene TS 脚本。
7. 调用 \`validate_visual_flow\`。如果校验失败，按 message 修正 visualFlow 后再次校验。
8. 生成最小测试用例：先覆盖改动点，再补必要回归。
9. 如用户给了 app 包，先调用 \`install_app\`。
10. 调用 \`run_flow\`，把返回的 liveUrl 明确给用户，让用户可以打开浏览器看实时执行。
11. 执行中调用 \`watch_run\` 观察状态。失败时先判断是环境/设备、IR 用例步骤、agent runtime 还是真实业务问题。
12. 如果失败原因是 IR 步骤不合理，只能调整 visualFlow 后重跑；不要读取或手写 Midscene TS 脚本。若是 Preflight 编译器/runtime 内部错误，停止并报告为工具缺陷。
13. 最终调用 \`save_report\`，并在回复中给出测试报告、report/liveUrl 和 PASS/FAIL 结论。
`;
}

function skillText(): string {
  return `---
name: preflight
description: Use when the user wants to test mobile app changes, run visualFlow IR cases, inspect device/runtime blockers, or debug failures with live viewer output.
---

# Preflight

Use the local Preflight MCP server to run mobile tests via visualFlow IR. The default path is visualFlow IR, not raw Midscene TypeScript.

Hard gate:

- This skill requires injected MCP tools named \`start_agent\`, \`doctor\`, \`config_status\`, \`list_devices\`, \`get_visual_flow_ir_rules\`, \`validate_visual_flow\`, \`run_flow\`, \`watch_run\`, and \`save_report\`.
- If those tools are unavailable in the current conversation, stop immediately and tell the user to restart Codex/Cursor or check the MCP config. Do not use shell commands, curl, npm scripts, or direct reads of this repository to imitate the MCP tools.
- When running from another project, inspect only that project's diff and files. Treat this repository as an implementation detail behind the MCP server.
- Do not ask the user to start test-service/platform for local testing. The MCP server auto-starts automation-agent in local MCP mode; the only universal required secret is a Midscene-compatible model API key.
- Preflight runs write report assets under \`~/.preflight/midscene_run/report/<reportName>/\`, including \`index.html\`, execution JSON, screenshots, and compressed recordings when ffmpeg and the platform recorder are available. Android recording uses scrcpy.
- Read Midscene model configuration from \`~/.preflight/config.json\`, \`~/.preflight/config.yaml\`, or \`~/.preflight/config.yml\`. Do not ask the user to put API keys in Codex/Cursor MCP environment variables.
- Do not write, inspect, or repair raw Midscene TypeScript scripts. If a run fails because the generated script cannot compile, go back to \`get_visual_flow_ir_rules\` + \`validate_visual_flow\` and adjust the visualFlow JSON. If the visualFlow validates but Preflight still compiles bad TypeScript, report a Preflight bug instead of reading this repository.

Workflow:

1. Inspect git diff and identify affected flows.
2. Start or reuse the local runtime with \`start_agent\`; \`doctor\` also auto-starts it.
3. Run \`doctor\`; stop on blocking failures such as missing model API key.
4. If config is unclear, call \`config_status\`; it reports loaded config path and key names without exposing values.
5. List devices with \`list_devices\`.
6. Read \`get_visual_flow_ir_rules\` and generate visualFlow JSON, not raw Midscene TypeScript.
7. Validate with \`validate_visual_flow\`; fix the JSON until validation passes.
8. Install the app when an app package path is provided.
9. Start the run with \`run_flow\` and show the returned liveUrl.
10. Poll with \`watch_run\`.
11. Analyze failures before retrying. Distinguish device/env failures, brittle IR steps, agent runtime failures, and real app bugs. For IR problems, revise visualFlow only; never switch to raw Midscene script repair.
12. Save report with \`save_report\`.

Reports are written under \`~/.preflight/midscene_run/report/<reportName>/\`.

If Preflight MCP tools are missing, tell the user to restart Codex after checking \`~/.codex/config.toml\` contains \`[mcp_servers.Preflight]\`. Do not continue with a fallback path.
`;
}

function userConfigExampleText(): string {
  return `{
  "env": {
    "MIDSCENE_MODEL_BASE_URL": "https://ark.cn-beijing.volces.com/api/v3",
    "MIDSCENE_MODEL_API_KEY": "replace-me",
    "MIDSCENE_MODEL_NAME": "doubao-seed-2-0-lite-260215",
    "MIDSCENE_MODEL_FAMILY": "doubao-seed",
    "MIDSCENE_MODEL_REASONING_ENABLED": "false"
  }
}
`;
}
