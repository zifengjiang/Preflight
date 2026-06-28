import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { homedir } from "node:os";
import { z } from "zod";
import { AgentHttpClient } from "./agentHttpClient.js";
import { AgentRuntimeManager } from "./agentRuntime.js";
import { runDoctor } from "./doctor.js";
import { writeEvidence } from "./evidence.js";
import { buildSaveReportContent } from "./live/saveReportContent.js";
import { startLiveViewer } from "./liveViewer.js";
import { RunManager } from "./runManager.js";
import { summarizeRun } from "./runSummary.js";
import { readReport } from "./reportReader.js";
import { loadPreflightUserConfig } from "./userConfig.js";
import { compileVisualFlow, validateVisualFlow } from "./visual-flow/index.js";
import { registerExplorationTools } from "./exploration/index.js";
import { createMidsceneSessionFromResourceId, ensureIosWdaStarted } from "./exploration/tools-session.js";
import { NetworkMockService } from "./network-mocks/NetworkMockService.js";
import type { NetworkMockRule } from "./visual-flow/types.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const MCP_SAFE_WAIT_MS = 45_000;
const RUN_POLL_INTERVAL_MS = 2_000;

export interface PreflightMcpOptions {
  agentBaseUrl?: string;
  agentToken?: string;
  livePort?: number;
  projectRoot?: string;
  runtimeRoot?: string;
}

export function createPreflightMcpServer(options: PreflightMcpOptions = {}): McpServer {
  const agentBaseUrl = options.agentBaseUrl ?? process.env.AGENT_BASE_URL ?? "http://127.0.0.1:18998";
  const livePort = options.livePort ?? Number(process.env.MCP_LIVE_PORT ?? "18999");
  const preflightHome = process.env.PREFLIGHT_HOME?.trim() || `${homedir()}/.preflight`;
  const projectRoot = options.runtimeRoot ?? process.env.AGENT_RUNTIME_ROOT?.trim() ?? options.projectRoot ?? process.env.PROJECT_ROOT ?? process.cwd();
  const client = new AgentHttpClient({ baseUrl: agentBaseUrl, token: options.agentToken ?? process.env.AGENT_HTTP_TOKEN });
  const loadConfigEnv = async () => (await loadPreflightUserConfig()).env;
  const runtime = new AgentRuntimeManager({ projectRoot, agentBaseUrl, client, env: process.env, runtimeRoot: options.runtimeRoot, loadConfigEnv });
  const liveBaseUrl = `http://127.0.0.1:${livePort}`;
  const runManager = new RunManager(client, liveBaseUrl);
  const networkMockService = new NetworkMockService();
  let liveServerStarted: Promise<void> | undefined;

  const server = new McpServer({ name: "Preflight", version: "0.1.0" });

  server.registerTool(
    "agent_health",
    {
      title: "Agent Health",
      description: "Check whether the local automation-agent HTTP service is reachable.",
    },
    async () => jsonResult(await runtime.status()),
  );

  server.registerTool(
    "start_agent",
    {
      title: "Start Agent",
      description: "Start or reuse the local automation-agent runtime required by Preflight MCP tools.",
    },
    async () => jsonResult(await runtime.ensureStarted()),
  );

  server.registerTool(
    "stop_agent",
    {
      title: "Stop Agent",
      description: "Stop the automation-agent process started by this MCP server. Does not kill manually-started agents.",
    },
    async () => jsonResult(await runtime.stop()),
  );

  server.registerTool(
    "start_ios_wda",
    {
      title: "Start iOS WebDriverAgent",
      description: "Start or ensure WebDriverAgent (WDA) is running on the specified iOS device. " +
        "Required before exploration_start for iOS devices. Call this when doctor reports iOS WebDriverAgent as not running.",
      inputSchema: {
        resourceId: z.string().describe("iOS device resource ID (e.g., ios:xxx-xxx-xxx)"),
      },
    },
    async ({ resourceId }) => {
      await runtime.ensureStarted();
      const configEnv = await loadConfigEnv();
      const runtimeEnv: Record<string, string> = { ...configEnv };
      return jsonResult(await ensureIosWdaStarted(resourceId, runtimeEnv, projectRoot));
    },
  );

  server.registerTool(
    "config_status",
    {
      title: "Config Status",
      description: "Show which Preflight user config file is loaded without exposing secret values.",
    },
    async () => {
      const config = await loadPreflightUserConfig();
      return jsonResult({
        path: config.path ?? null,
        keys: Object.keys(config.env).sort(),
      });
    },
  );

  server.registerTool(
    "get_visual_flow_ir_rules",
    {
      title: "Get Visual Flow IR Rules",
      description: "Return the low-noise Visual Flow IR rules that the model should follow when generating test cases.",
    },
    async () => {
      const text = await readFile(join(projectRoot, "docs", "visual-flow-ir-llm.md"), "utf8").catch(() => "");
      return { content: [{ type: "text" as const, text: `${VISUAL_FLOW_LLM_HARD_RULES}\n\n${text}` }] };
    },
  );

  server.registerTool(
    "validate_visual_flow",
    {
      title: "Validate Visual Flow",
      description: "Validate a generated visualFlow JSON before compiling or running it.",
      inputSchema: {
        visualFlow: z.record(z.unknown()),
      },
    },
    async ({ visualFlow }) => jsonResult(validateVisualFlow(visualFlow)),
  );

  server.registerTool(
    "doctor",
    {
      title: "Doctor",
      description: "Auto-start the local automation-agent, then check blocking dependencies (Midscene API key, adb, hdc, Xcode/xcrun, iproxy) and iOS WebDriverAgent health.",
    },
    async () =>
      jsonResult(
        await runDoctor({
          env: { ...process.env, ...(await loadConfigEnv()) },
          agentHealth: async () => (await runtime.ensureStarted()).health ?? client.health(),
        }),
      ),
  );

  server.registerTool(
    "list_devices",
    {
      title: "List Devices",
      description: "List devices currently visible to the local automation-agent.",
    },
    async () => {
      await runtime.ensureStarted();
      return jsonResult(await client.listDevices());
    },
  );

  server.registerTool(
    "install_app",
    {
      title: "Install App",
      description: "Install an app package on a selected local device through automation-agent.",
      inputSchema: {
        resourceId: z.string().describe("Device resource id, for example android:serial or ios:udid."),
        appRef: z.string().describe("Local path, file:// URL, or http(s) URL of the app package."),
      },
    },
    async ({ resourceId, appRef }) => {
      await runtime.ensureStarted();
      return jsonResult(await client.installApp(resourceId, appRef));
    },
  );

  server.registerTool(
    "run_flow",
    {
      title: "Run Visual Flow Test",
      description: "Validate and compile a visualFlow JSON, then run it through the local automation-agent with live viewer support. " +
        "IMPORTANT: MCP transport has a 60-second timeout. For multi-step flows (3+ steps), the test WILL NOT finish within this timeout. " +
        "Strategy for long-running tests: " +
        "(1) Set waitForCompletion to false — the tool returns immediately with a runId. " +
        "(2) Then poll with watch_run (without waitForCompletion) until status shows completed/failed. " +
        "Only set waitForCompletion: true for very short flows (1-2 steps) where total time is under 60s.",
      inputSchema: {
        platform: z.enum(["ANDROID", "IOS", "HARMONY"]),
        visualFlow: z.record(z.unknown()),
        resourceId: z.string().optional(),
        appRef: z.string().optional(),
        testIntent: z.string().optional(),
        runtimeEnv: z.record(z.string()).optional(),
        waitForCompletion: z.boolean().optional().describe(
          "Set to false for multi-step flows (3+ steps) — returns immediately with a runId, then poll with watch_run. " +
          "Set to true only for very short flows (1-2 steps) that finish within the MCP 60s transport timeout."
        ),
        timeoutMs: z.number().int().positive().optional().describe(
          "Maximum wait time in milliseconds for the test to complete. " +
          "Capped internally at 45000ms so the MCP response returns before the 60s transport timeout. " +
          "NOTE: Only effective when waitForCompletion is true. " +
          "For long runs, use waitForCompletion: false and poll with watch_run instead."
        ),
      },
    },
    async (input) => {
      await runtime.ensureStarted();
      const parsed = validateVisualFlow(input.visualFlow);
      if (!parsed.ok) return jsonResult(parsed);
      const hasNetworkMocks = (parsed.value.networkMocks?.length ?? 0) > 0;
      let mocksStarted = false;
      if (hasNetworkMocks && input.resourceId) {
        const deviceId = input.resourceId.includes(":") ? input.resourceId.split(":")[1]! : input.resourceId;
        const platform = input.platform.toLowerCase() as "android" | "ios";
        try {
          await networkMockService.start({
            rules: parsed.value.networkMocks!,
            platform,
            deviceId,
          });
          mocksStarted = true;
        } catch (err) {
          return jsonResult({
            ok: false,
            message: `启动网络 mock 失败: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
      // When waitForCompletion is false we hand mock ownership to the caller
      // (watch_run/cancel_run tear them down on terminal state). Otherwise this
      // handler owns teardown and must run it on success AND on any throw.
      let mockOwnershipTransferred = false;
      try {
        liveServerStarted ??= startLiveViewer(livePort, runManager).then((viewer) => {
          runManager.setLiveBaseUrl(viewer.baseUrl);
        });
        await liveServerStarted;
        const script = await compileVisualFlow(parsed.value);
        const mergedEnv = { ...preflightRunDefaults(), ...(await loadConfigEnv()), ...input.runtimeEnv };
        const started = await runManager.startRun({
          platform: input.platform,
          script,
          scriptKind: "midscene",
          resourceId: input.resourceId,
          appRef: input.appRef,
          testIntent: input.testIntent,
          runtimeEnv: mergedEnv,
          runtimeRoot: projectRoot,
          visualFlow: parsed.value,
        });
        if (!input.waitForCompletion) {
          mockOwnershipTransferred = true;
          return jsonResult({
            ...started,
            visualFlow: parsed.value,
            ...(mocksStarted ? { networkMocksActive: true } : {}),
          });
        }
        const result = await runManager.waitForRun(started.runId, safeMcpWaitMs(input.timeoutMs), RUN_POLL_INTERVAL_MS);
        return jsonResult(result);
      } finally {
        if (mocksStarted && !mockOwnershipTransferred) {
          try { await networkMockService.stop(); } catch { /* cleanup */ }
        }
      }
    },
  );

  server.registerTool(
    "watch_run",
    {
      title: "Watch Test Run",
      description: "Refresh and summarize a test run. Use while the live viewer is open. " +
        "For long-running tests that exceed the MCP transport timeout (60s): " +
        "(1) Call run_flow with waitForCompletion: false to get a runId. " +
        "(2) Call watch_run to poll the run. It waits up to 45s by default and returns early when the run succeeds or fails. " +
        "Do NOT call run_flow again — that creates a duplicate run.",
      inputSchema: {
        runId: z.string(),
        waitForCompletion: z.boolean().optional().describe(
          "Set to true to block until the run finishes (respects timeoutMs). " +
          "Omit or set to false for a lightweight status check — use this for polling."
        ),
        timeoutMs: z.number().int().positive().optional().describe(
          "Maximum wait time in milliseconds. " +
          "Capped internally at 45000ms so the MCP response returns before the 60s transport timeout. " +
          "NOTE: Only effective when waitForCompletion is true. " +
          "Prefer polling without waitForCompletion for long runs."
        ),
      },
    },
    async ({ runId, waitForCompletion, timeoutMs }) => {
      await runtime.ensureStarted();
      const summary = waitForCompletion
        ? await runManager.waitForRun(runId, safeMcpWaitMs(timeoutMs), RUN_POLL_INTERVAL_MS)
        : await runManager.watchRun(runId, MCP_SAFE_WAIT_MS);
      // Auto-cleanup mocks on terminal state
      if (["SUCCESS", "FAILED", "CANCELLED"].includes(summary.status) && networkMockService.isRunning()) {
        try { await networkMockService.stop(); } catch { /* cleanup */ }
      }
      return jsonResult(summary);
    },
  );

  server.registerTool(
    "cancel_run",
    {
      title: "Cancel Test Run",
      description: "Cancel a running test. Use this when the test is taking too long or you want to stop it early. " +
        "After cancellation, poll watch_run to confirm the status becomes CANCELLED.",
      inputSchema: {
        runId: z.string(),
        reason: z.string().optional().describe("Why the run was cancelled (e.g. 'test took too long', 'debug info collected')"),
      },
    },
    async ({ runId, reason }) => {
      await runtime.ensureStarted();
      const result = await runManager.cancelRun(runId, "model", reason ?? "no reason given");
      // Clean up network mocks if they were auto-started for this run
      if (networkMockService.isRunning()) {
        try { await networkMockService.stop(); } catch { /* cleanup */ }
      }
      return jsonResult(result);
    },
  );

  server.registerTool(
    "save_report",
    {
      title: "Save Test Report",
      description: "Save the test report for a completed or failed test run.",
      inputSchema: {
        runId: z.string(),
      },
    },
    async ({ runId }) => {
      await runtime.ensureStarted();
      await runManager.watchRun(runId);
      const run = runManager.getRun(runId);
      if (!run) throw new Error(`Unknown runId: ${runId}`);
      const summary = summarizeRun(run);
      const evidence = await writeEvidence({
        outputRoot: preflightHome,
        run: {
          ...run,
          status: summary.status,
          failureAnalysis: summary.failureAnalysis,
          reportDir: run.reportDir,
        },
      });
      const summaryText = JSON.stringify(
        { status: summary.status, evidencePath: evidence.evidencePath, failureAnalysis: summary.failureAnalysis },
        null,
        2,
      );
      return { content: buildSaveReportContent({ summaryText, evidencePath: evidence.evidencePath, cardPngBase64: evidence.cardPngBase64 }) };
    },
  );

  server.registerTool(
    "read_report",
    {
      title: "Read Test Report",
      description: "Read a Midscene test run report directory and extract the operation path (what actually happened during the test). " +
        "The reportDir is the path to the report directory containing N.execution.json files, " +
        "typically found under ~/.preflight/midscene_run/report/. " +
        "Returns the operation path with step-by-step details that the model can summarize.",
      inputSchema: {
        reportDir: z.string().describe("Absolute path to the Midscene report directory containing *.execution.json files"),
      },
    },
    async ({ reportDir }) => {
      const result = await readReport(reportDir);
      return jsonResult(result);
    },
  );

  server.registerTool(
    "start_network_mocks",
    {
      title: "Start Network Mocks",
      description:
        "Start the network mock HTTP/HTTPS proxy server and configure the device to route traffic through it. " +
        "Matching requests return mock responses; non-matching traffic is forwarded transparently. " +
        "Automatically generates a Root CA certificate for HTTPS MITM interception. " +
        "Use before a test run to mock API responses that the app depends on. " +
        "Currently supports Android emulator (iOS simulator deferred to phase 2).",
      inputSchema: {
        platform: z.enum(["ANDROID", "IOS"]).describe("Device platform"),
        resourceId: z.string().describe("Device resource ID from list_devices (e.g., android:emulator-5554)"),
        port: z.number().int().positive().optional().describe("Preferred port (e.g., to match existing device proxy config)"),
        rules: z.array(z.object({
          hostRegex: z.string().describe("Regex matched against the CONNECT host (SNI); gates MITM/decryption. Example: \"api\\\\.example\\\\.com$\""),
          pathPattern: z.string().optional().describe("Substring match on request path (both path fields omitted = all paths)"),
          pathRegex: z.string().optional().describe("Regex match on request path"),
          method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional().describe("HTTP method to match (default: any)"),
          queryParams: z.record(z.string()).optional().describe("Key-value pairs that must be present in the query string"),
          responses: z.array(z.object({
            status: z.number().int().min(100).max(599).optional().describe("HTTP status code (default: 200)"),
            body: z.string().describe("Response body, typically a JSON string"),
            requestBodyMatch: z.record(z.string()).optional().describe("Key-value pairs that must match in the request body"),
            callIndex: z.number().int().positive().optional().describe("Only match on the nth call (1-based, for stateful sequences)"),
            headers: z.record(z.string()).optional().describe("Optional response headers"),
            delay: z.number().int().min(0).optional().describe("Delay in ms before responding"),
          })).optional().describe("Static responses (XOR with handler; omit both for record-only)"),
          handler: z.string().optional().describe("Inline JS: (req, ctx) => response | null (Task 5)"),
          description: z.string().optional().describe("Human-readable description"),
        })),
      },
    },
    async (input) => {
      await runtime.ensureStarted();
      const platform = input.platform.toLowerCase() as "android" | "ios";
      const deviceId = input.resourceId.includes(":") ? input.resourceId.split(":")[1]! : input.resourceId;
      const rules: NetworkMockRule[] = input.rules.map((r) => ({
        hostRegex: r.hostRegex,
        ...(r.pathPattern ? { pathPattern: r.pathPattern } : {}),
        ...(r.pathRegex ? { pathRegex: r.pathRegex } : {}),
        ...(r.method ? { method: r.method } : {}),
        ...(r.queryParams ? { queryParams: r.queryParams } : {}),
        ...(r.responses ? { responses: r.responses.map((resp) => ({
          ...(resp.status != null ? { status: resp.status } : {}),
          body: resp.body,
          ...(resp.requestBodyMatch ? { requestBodyMatch: resp.requestBodyMatch } : {}),
          ...(resp.callIndex != null ? { callIndex: resp.callIndex } : {}),
          ...(resp.headers ? { headers: resp.headers } : {}),
          ...(resp.delay != null ? { delay: resp.delay } : {}),
        })) } : {}),
        ...(r.handler ? { handler: r.handler } : {}),
        ...(r.description ? { description: r.description } : {}),
      }));
      return jsonResult(await networkMockService.start({ rules, platform, deviceId, preferredPort: input.port }));
    },
  );

  server.registerTool(
    "stop_network_mocks",
    {
      title: "Stop Network Mocks",
      description:
        "Stop the network mock server and remove device proxy configuration. " +
        "Call this after the test completes to restore normal network traffic.",
    },
    async () => jsonResult(await networkMockService.stop()),
  );

  server.registerTool(
    "get_network_mock_status",
    {
      title: "Get Network Mock Status",
      description:
        "Get the current network mock server status and per-rule call statistics. " +
        "Use to verify that mocks are being hit as expected during a test.",
    },
    async () => jsonResult(networkMockService.getStats()),
  );

  server.registerTool(
    "update_network_mock_rules",
    {
      title: "Update Network Mock Rules",
      description:
        "Hot-reload mock rules without stopping the server. " +
        "Use to change mock responses mid-test without restarting the proxy.",
      inputSchema: {
        rules: z.array(z.object({
          hostRegex: z.string().describe("Regex matched against the CONNECT host (SNI)"),
          pathPattern: z.string().optional().describe("Substring match on request path"),
          pathRegex: z.string().optional().describe("Regex match on request path"),
          method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional(),
          queryParams: z.record(z.string()).optional(),
          responses: z.array(z.object({
            status: z.number().int().min(100).max(599).optional(),
            body: z.string(),
            requestBodyMatch: z.record(z.string()).optional(),
            callIndex: z.number().int().positive().optional(),
            headers: z.record(z.string()).optional(),
            delay: z.number().int().min(0).optional(),
          })).optional().describe("Static responses (XOR with handler; omit both for record-only)"),
          handler: z.string().optional(),
          description: z.string().optional(),
        })),
      },
    },
    async ({ rules }) => {
      if (!networkMockService.isRunning()) {
        return jsonResult({ ok: false, message: "network mocks not running — call start_network_mocks first" });
      }
      const parsed: NetworkMockRule[] = rules.map((r) => ({
        hostRegex: r.hostRegex,
        ...(r.pathPattern ? { pathPattern: r.pathPattern } : {}),
        ...(r.pathRegex ? { pathRegex: r.pathRegex } : {}),
        ...(r.method ? { method: r.method } : {}),
        ...(r.queryParams ? { queryParams: r.queryParams } : {}),
        ...(r.responses ? { responses: r.responses.map((resp) => ({
          ...(resp.status != null ? { status: resp.status } : {}),
          body: resp.body,
          ...(resp.requestBodyMatch ? { requestBodyMatch: resp.requestBodyMatch } : {}),
          ...(resp.callIndex != null ? { callIndex: resp.callIndex } : {}),
          ...(resp.headers ? { headers: resp.headers } : {}),
          ...(resp.delay != null ? { delay: resp.delay } : {}),
        })) } : {}),
        ...(r.handler ? { handler: r.handler } : {}),
        ...(r.description ? { description: r.description } : {}),
      }));
      networkMockService.updateRules(parsed);
      return jsonResult({ ok: true, updated: parsed.length });
    },
  );

  server.registerTool(
    "get_root_ca_cert",
    {
      title: "Get Root CA Certificate",
      description:
        "Export the Preflight MITM Root CA certificate (PEM format). " +
        "Install this certificate on your iOS/Android device to enable HTTPS interception. " +
        "iOS: Send the cert to the device (e.g. AirDrop), open it, go to Settings > Profile Downloaded > Install. " +
        "Then Settings > General > About > Certificate Trust Settings > Enable full trust for 'Preflight Mock CA'. " +
        "Android: Settings > Security > Encryption & credentials > Install a certificate > CA certificate. " +
        "Only available when network mocks are running.",
    },
    async () => {
      const cert = networkMockService.getRootCACert();
      if (!cert) return jsonResult({ ok: false, message: "network mocks not running — call start_network_mocks first" });
      return { content: [{ type: "text" as const, text: cert }] };
    },
  );

  server.registerTool(
    "start_recording",
    {
      title: "Start Network Recording",
      description:
        "Start recording network traffic through the mock proxy. All requests and responses are captured " +
        "and can be exported as mock rules via export_recorded_rules. Network mocks must already be running.",
    },
    async () => {
      if (!networkMockService.isRunning()) {
        return jsonResult({ ok: false, message: "network mocks not running — call start_network_mocks first" });
      }
      networkMockService.setRecording(true);
      return jsonResult({ ok: true, message: "Recording started" });
    },
  );

  server.registerTool(
    "stop_recording",
    {
      title: "Stop Network Recording",
      description: "Stop recording and return the count of captured requests.",
    },
    async () => {
      if (!networkMockService.isRunning()) {
        return jsonResult({ ok: false, message: "network mocks not running" });
      }
      const count = networkMockService.getRecordedCount();
      networkMockService.setRecording(false);
      return jsonResult({ ok: true, recorded: count });
    },
  );

  server.registerTool(
    "export_recorded_rules",
    {
      title: "Export Recorded Rules",
      description:
        "Export recorded network traffic as NetworkMockRule[]. " +
        "Duplicated URLs are merged, request bodies generate requestBodyMatch rules, " +
        "and sequential responses are assigned callIndex. " +
        "Use after stop_recording to convert captured traffic into reusable mock rules.",
    },
    async () => {
      const rules = networkMockService.exportRecordedRules();
      return jsonResult({ ok: true, count: rules.length, rules });
    },
  );

  registerExplorationTools(server, { client, loadConfigEnv, ensureAgentStarted: async () => { await runtime.ensureStarted(); }, createSessionFromMeta: createMidsceneSessionFromResourceId, projectRoot });

  return server;
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function safeMcpWaitMs(timeoutMs?: number): number {
  return Math.min(timeoutMs ?? MCP_SAFE_WAIT_MS, MCP_SAFE_WAIT_MS);
}

function preflightRunDefaults(): Record<string, string> {
  return {
    MIDSCENE_OUTPUT_FORMAT: "html-and-external-assets",
    MIDSCENE_RECORD_VIDEO_ENABLED: "1",
    MIDSCENE_RECORD_VIDEO_PLAYBACK_RATE: "2",
    MIDSCENE_RECORD_VIDEO_SCALE_WIDTH: "540",
    MIDSCENE_RECORD_VIDEO_CRF: "32",
    MIDSCENE_RECORD_VIDEO_PRESET: "fast",
    MIDSCENE_RUN_TIMEOUT_MS: "1200000",  // 20分钟，适配多步骤流程
    MIDSCENE_REPLANNING_CYCLE_LIMIT: "10",  // 避免死循环
  };
}

const VISUAL_FLOW_LLM_HARD_RULES = `# Preflight Visual Flow IR hard rules

- Use visualFlow JSON as the output format.
- Variables declared by scriptVars, setVar, assignVar, or transformVar must be referenced only with interpolation syntax: {{varName}}, {{varName[0]}}, {{varName.1}}, or {{varName.length}}.
- In prompt/value/expression fields, write declared variables with interpolation syntax. Example: "{{timeBefore}}和{{timeAfter}}不同".
- If a value comes from a previous step, create it with setVar/assignVar/transformVar first, then reference it with {{}} in later steps.
- Use aiAct for complex multi-step interactions that need visual planning. Describe the user goal and important constraints, then let the visual model plan the concrete taps/swipes/inputs.
- Use setAIActContext to define cross-step handling for unexpected UI, for example "遇到权限弹窗请同意，营销弹窗请拒绝". This context is carried into later act operations, so the visual model can handle temporary popups as part of the normal action flow.
- Use fixed sleep steps for page transitions, app launch, refresh, animations, and list updates, for example {"type":"sleep","ms":3000}.
- Place assert steps only at critical verification points, usually the changed behavior or necessary regression checkpoint. Normal action failures already stop the run.
- Make every step prompt self-contained. Each step is executed as an independent visual instruction, so include the necessary target, expected state, or comparison data inside that step.
- Keep prompts concise and explicit. Provide the required information only; the visual model plans detailed interaction from clear short instructions.
`;
