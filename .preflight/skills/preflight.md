---
name: preflight
description: Use when the user wants to test mobile app changes, run visualFlow IR cases, inspect device/runtime blockers, or debug failures with live viewer output.
---

# Preflight

Use the local Preflight MCP server to run mobile tests via visualFlow IR. The default path is visualFlow IR, not raw Midscene TypeScript.

Hard gate:

- This skill requires injected MCP tools named `start_agent`, `doctor`, `config_status`, `list_devices`, `get_visual_flow_ir_rules`, `validate_visual_flow`, `run_flow`, `watch_run`, and `save_report`.
- If those tools are unavailable in the current conversation, stop immediately and tell the user to restart Codex/Cursor or check the MCP config. Do not use shell commands, curl, npm scripts, or direct reads of this repository to imitate the MCP tools.
- When running from another project, inspect only that project's diff and files. Treat this repository as an implementation detail behind the MCP server.
- Do not ask the user to start test-service/platform for local testing. The MCP server auto-starts automation-agent in local MCP mode; the only universal required secret is a Midscene-compatible model API key.
- Preflight runs write report assets under `~/.preflight/midscene_run/report/<reportName>/`, including `index.html`, execution JSON, screenshots, and compressed recordings when ffmpeg and the platform recorder are available. Android recording uses scrcpy.
- Read Midscene model configuration from `~/.preflight/config.json`, `~/.preflight/config.yaml`, or `~/.preflight/config.yml`. Do not ask the user to put API keys in Codex/Cursor MCP environment variables.
- Do not write, inspect, or repair raw Midscene TypeScript scripts. If a run fails because the generated script cannot compile, go back to `get_visual_flow_ir_rules` + `validate_visual_flow` and adjust the visualFlow JSON. If the visualFlow validates but Preflight still compiles bad TypeScript, report a Preflight bug instead of reading this repository.

Workflow:

1. Inspect git diff and identify affected flows.
2. Start or reuse the local runtime with `start_agent`; `doctor` also auto-starts it.
3. Run `doctor`; stop on blocking failures such as missing model API key.
4. If config is unclear, call `config_status`; it reports loaded config path and key names without exposing values.
5. List devices with `list_devices`.
6. Read `get_visual_flow_ir_rules` and generate visualFlow JSON, not raw Midscene TypeScript.
7. Validate with `validate_visual_flow`; fix the JSON until validation passes.
8. Install the app when an app package path is provided.
9. Start the run with `run_flow` and show the returned liveUrl.
10. Poll with `watch_run`.
11. Analyze failures before retrying. Distinguish device/env failures, brittle IR steps, agent runtime failures, and real app bugs. For IR problems, revise visualFlow only; never switch to raw Midscene script repair.
12. Save report with `save_report`.

Reports are written under `~/.preflight/midscene_run/report/<reportName>/`.

If Preflight MCP tools are missing, tell the user to restart Codex after checking `~/.codex/config.toml` contains `[mcp_servers.Preflight]`. Do not continue with a fallback path.
