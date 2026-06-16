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
  claudeSkillPath: string;
  androidEmulatorSetupSkillPath: string;
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
  const claudeSkillPath = join(homedir(), ".claude", "skills", "preflight", "SKILL.md");
  const androidEmulatorSetupSkillPath = join(homedir(), ".claude", "skills", "android-emulator-setup", "SKILL.md");
  const userConfigExamplePath = join(homedir(), ".preflight", "config.example.json");
  const codexConfigPath = join(homedir(), ".codex", "config.toml");

  await writeCursorMcpConfig(cursorConfigPath, options.projectRoot, agentBaseUrl, livePort, isRuntime, runtimeRoot);
  await writeTextFile(cursorRulePath, cursorRuleText());
  await writeTextFile(skillPath, skillText());
  await writeTextFile(codexSkillPath, skillText());
  await writeTextFile(agentsSkillPath, skillText());
  await writeTextFile(claudeSkillPath, skillText());
  await writeTextFile(androidEmulatorSetupSkillPath, androidEmulatorSetupSkillText());
  await writeTextFile(userConfigExamplePath, userConfigExampleText());
  await upsertCodexMcpConfig(codexConfigPath, options.projectRoot, agentBaseUrl, livePort, isRuntime, runtimeRoot);

  return { cursorConfigPath, cursorRulePath, codexConfigPath, skillPath, codexSkillPath, agentsSkillPath, claudeSkillPath, androidEmulatorSetupSkillPath, runtimeRoot, userConfigExamplePath };
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
8. **每条 visualFlow 必须以冷启动开始**：第一个步骤总是 \`closeApp\` + \`launch\`（同一个 packageName），确保 app 从已知初始状态执行。不要在已打开的 app 上接着跑测试；不确定 app 已在哪个页面时，一律重启。
9. 生成最小测试用例：先覆盖改动点，再补必要回归。
10. 如用户给了 app 包，先调用 \`install_app\`。
11. 调用 \`run_flow\` 时必须设置 \`waitForCompletion: false\`，让工具立即返回 runId/liveUrl；不要用 \`waitForCompletion: true\` 等待完整流程，避免 MCP 60 秒传输超时。
12. 执行中调用 \`watch_run\` 观察状态；工具默认等待最多 45 秒，run 一旦成功或失败会提前返回。失败时先判断是环境/设备、IR 用例步骤、agent runtime 还是真实业务问题。
13. 如果失败原因是 IR 步骤不合理，只能调整 visualFlow 后重跑；不要读取或手写 Midscene TS 脚本。若是 Preflight 编译器/runtime 内部错误，停止并报告为工具缺陷。
14. 最终调用 \`save_report\`，并在回复中给出测试报告、report/liveUrl 和 PASS/FAIL 结论。
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
8. **Every visualFlow MUST begin with a cold start.** The first two steps are always \`closeApp\` then \`launch\` (same packageName). This guarantees the app starts from a known, clean initial state. Never skip this — even if the app is already open on the target screen.
9. Install the app when an app package path is provided.
10. Start the run with \`run_flow\` using \`waitForCompletion: false\`, then show the returned liveUrl. Never wait for a full flow inside \`run_flow\`; MCP transport can time out after about 60 seconds.
11. Poll with \`watch_run\`; it waits up to 45s by default and returns early when the run succeeds or fails.
12. Analyze failures before retrying. Distinguish device/env failures, brittle IR steps, agent runtime failures, and real app bugs. For IR problems, revise visualFlow only; never switch to raw Midscene script repair.
13. Save report with \`save_report\`.

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

function androidEmulatorSetupSkillText(): string {
  return `---
name: android-emulator-setup
description: Use when setting up an Android emulator from scratch, installing Android SDK command-line tools, creating AVDs, or when emulator/adb/avdmanager commands are not found. Also use when the user asks to install, configure, or bootstrap an Android development environment.
---

# Android Emulator Setup

Install the Android SDK command-line tools, create AVDs, and start emulators — the prerequisite step before Argent or Preflight can interact with a device.

## Quick Detection

Run these before doing any work. Skip sections whose tools already work.

\`\`\`bash
adb --version 2>/dev/null && echo "ADB OK" || echo "ADB MISSING"
emulator -list-avds 2>/dev/null && echo "EMULATOR OK" || echo "EMULATOR MISSING"
echo "ANDROID_HOME=\${ANDROID_HOME:-UNSET}"
\`\`\`

| Result | Action |
|--------|--------|
| ADB MISSING | Start from § Install SDK |
| EMULATOR MISSING, ADB OK | Jump to § Install SDK Components |
| Both OK, no AVDs | Jump to § Create AVD |
| Both OK, AVD exists | Jump to § Start Emulator |

## Install SDK

**macOS with Homebrew (recommended):**

\`\`\`bash
brew install android-commandlinetools
\`\`\`

**Manual install (macOS/Linux):**

\`\`\`bash
# 1. Download from https://developer.android.com/studio#command-line-tools-only
# 2. Unzip to the correct path:
mkdir -p ~/Library/Android/sdk/cmdline-tools/latest
cd ~/Library/Android/sdk/cmdline-tools/latest
unzip ~/Downloads/commandlinetools-mac-*.zip
\`\`\`

## Configure Environment

Add to \`~/.zshrc\` (or \`~/.bashrc\`):

\`\`\`bash
# With brew:
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
# With manual install:
# export ANDROID_HOME=$HOME/Library/Android/sdk

export PATH=$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH
\`\`\`

Then \`source ~/.zshrc\` and verify:

\`\`\`bash
sdkmanager --version  # should print a version
\`\`\`

## Install SDK Components

\`\`\`bash
# Accept licenses (non-interactive)
yes | sdkmanager --licenses

# Install core components
sdkmanager "platform-tools" "emulator" "platforms;android-34"

# Install a system image (ARM Mac → arm64-v8a, Intel → x86_64)
sdkmanager "system-images;android-34;google_apis;arm64-v8a"
\`\`\`

> **Pick the right system image:** \`sdkmanager --list | grep system-images\` to see available images. API 34 is a safe default; adjust based on the app's \`minSdk\`.

## Create AVD

\`\`\`bash
avdmanager create avd \\
  -n test_device \\
  -k "system-images;android-34;google_apis;arm64-v8a" \\
  -d "pixel_6"
\`\`\`

Verify: \`emulator -list-avds\` should show \`test_device\`.

## Start Emulator

\`\`\`bash
emulator -avd test_device &
\`\`\`

Wait for boot (1-2 min), then verify:

\`\`\`bash
adb devices
# List of devices attached
# emulator-5554   device
\`\`\`

## Common Issues

| Symptom | Fix |
|---------|-----|
| \`sdkmanager: command not found\` | \`cmdline-tools/latest/bin\` not in PATH; check § Configure Environment |
| \`avdmanager: command not found\` | Same as above — part of cmdline-tools |
| Emulator black screen on Apple Silicon | Ensure system image is \`arm64-v8a\`, not \`x86_64\` |
| \`adb devices\` shows \`unauthorized\` | Wait 30s for emulator to finish booting |
| \`The emulator process has terminated\` | Try \`emulator -avd test_device -wipe-data\` |
| \`ANDROID_HOME\` not set after brew install | Brew's path is \`/opt/homebrew/share/android-commandlinetools\` |
| \`PANIC: Missing emulator engine\` | Run \`sdkmanager "emulator"\` to install the emulator binary |
| No space left on device | System images are ~1-2 GB; \`sdkmanager --uninstall\` unused images |

## Post-Setup

Once the emulator is running, it's ready for:
- **Argent:** \`argent-android-emulator-setup\` skill (boot, connect, interact)
- **Preflight:** \`preflight\` skill (visual-flow tests via MCP)

To kill: \`adb -s emulator-5554 emu kill\`
`;
}
