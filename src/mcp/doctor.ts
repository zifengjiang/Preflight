import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentHealth } from "./types.js";
import { adbRootIndicatesNonRootable } from "./network-mocks/device-ca.js";

const pExecFile = promisify(execFile);

export type CheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  title: string;
  status: CheckStatus;
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  summary: string;
  checks: DoctorCheck[];
}

export interface DoctorDeps {
  env: NodeJS.ProcessEnv;
  agentHealth: () => Promise<AgentHealth>;
  commandExists?: (command: string) => Promise<boolean>;
}

const MIDSCENE_KEY_NAMES = [
  "MIDSCENE_MODEL_API_KEY",
  "MIDSCENE_API_KEY",
  "MIDSCENE_OPENAI_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
];

// ---------------------------------------------------------------------------
// iOS WebDriverAgent health check
// ---------------------------------------------------------------------------

function checkWdaHealth(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = http.get(`http://${host}:${port}/status`, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve(body.trim().length > 0));
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function iosWdaHealthCheck(env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  const host = env.MIDSCENE_IOS_WDA_HOST || "127.0.0.1";
  const defaultPort = Number(env.MIDSCENE_IOS_WDA_PORT) || 8200;
  const candidates = new Set<number>();

  // Try to discover running WDA ports from the watchdog port map
  const portMapPath = env.IOS_WDA_PORT_MAP_FILE_PATH
    || join(homedir(), ".preflight", "runtime", ".wda-agent-state", "wda-port-map.json");
  try {
    const raw = await readFile(portMapPath, "utf8");
    const parsed = JSON.parse(raw) as { portsByUdid?: Record<string, number> };
    if (parsed?.portsByUdid) {
      for (const p of Object.values(parsed.portsByUdid)) {
        if (typeof p === "number" && Number.isFinite(p) && p > 0) {
          candidates.add(Math.floor(p));
        }
      }
    }
  } catch {
    // port map not found — fall back to default port
  }
  candidates.add(defaultPort);

  for (const port of candidates) {
    if (await checkWdaHealth(host, port, 2000)) {
      return {
        id: "ios-wda",
        title: "iOS WebDriverAgent",
        status: "pass",
        message: `WebDriverAgent is healthy on ${host}:${port}.`,
      };
    }
  }

  const portList = [...candidates].sort((a, b) => a - b).join(", ");
  return {
    id: "ios-wda",
    title: "iOS WebDriverAgent",
    status: "warn",
    message: `WebDriverAgent is not running (checked host=${host}, ports=${portList}). iOS automation needs WDA. Call "start_ios_wda" tool to start it, or ensure the WDA watchdog is running.`,
  };
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const commandExists = deps.commandExists ?? defaultCommandExists;
  const checks: DoctorCheck[] = [];

  const agent = await deps.agentHealth();
  checks.push({
    id: "agent-http",
    title: "Automation Agent HTTP",
    status: agent.ok ? "pass" : "fail",
    message: agent.ok ? "Agent HTTP is reachable." : `Agent HTTP is not reachable: ${agent.error ?? "unknown error"}`,
  });

  const keyName = MIDSCENE_KEY_NAMES.find((name) => deps.env[name]?.trim());
  checks.push({
    id: "midscene-api-key",
    title: "Midscene API Key",
    status: keyName ? "pass" : "fail",
    message: keyName
      ? `${keyName} is set.`
      : `Missing Midscene model API key. Set one of: ${MIDSCENE_KEY_NAMES.join(", ")}.`,
  });

  checks.push(await commandCheck("android-adb", "Android adb", "adb", commandExists, "Android tests need adb in PATH."));
  checks.push(await commandCheck("ffmpeg", "ffmpeg", "ffmpeg", commandExists, "Video recording needs ffmpeg in PATH."));
  checks.push(await commandCheck("scrcpy", "scrcpy", "scrcpy", commandExists, "Android video recording needs scrcpy in PATH."));
  checks.push(await commandCheck("harmony-hdc", "Harmony hdc", deps.env.MIDSCENE_HARMONY_HDC_PATH || deps.env.AGENT_HARMONY_HDC_PATH || "hdc", commandExists, "Harmony tests need hdc or MIDSCENE_HARMONY_HDC_PATH."));
  checks.push(await commandCheck("ios-xcode", "iOS Xcode tools", "xcrun", commandExists, "iOS tests need Xcode command line tools."));
  checks.push(await commandCheck("ios-iproxy", "iOS iproxy", "iproxy", commandExists, "iOS WDA live view needs iproxy."));
  checks.push(await iosWdaHealthCheck(deps.env));
  await androidEmulatorRootableCheck(checks);

  const blocking = checks.filter((check) => check.status === "fail");
  const nonPass = checks.filter((check) => check.status !== "pass");
  return {
    ok: blocking.length === 0,
    summary: blocking.length === 0 ? "All blocking checks passed." : `${blocking.length} blocking issue(s) found.`,
    checks: nonPass,
  };
}

/**
 * Non-blocking check: if an Android emulator is attached, run `adb -s <serial> root`
 * and warn when the image is a production (Play Store) build that refuses root.
 * Network mock CA install requires a rootable (non-Play) emulator image.
 * Skips silently when adb is unavailable or no emulator serial is found.
 *
 * Note: `adb root` restarts adbd as a side-effect — acceptable for a diagnostic
 * command; gated to emulators only (never runs against real device serials).
 */
async function androidEmulatorRootableCheck(checks: DoctorCheck[]): Promise<void> {
  try {
    // List attached devices and find the first emulator serial.
    const devicesOut = await pExecFile("adb", ["devices"], { timeout: 8_000 }).then((r) => r.stdout).catch(() => "");
    const emulatorSerial = devicesOut
      .split("\n")
      .map((l) => l.trim())
      // "device" is the adb status token (online); offline/unauthorized
      // emulators carry a different token and are correctly skipped.
      .find((l) => l.startsWith("emulator-") && l.includes("device"))
      ?.split(/\s+/)[0];
    if (!emulatorSerial) return; // no emulator connected — skip silently

    // Capture stdout+stderr even on non-zero exit: the production-build refusal
    // is printed by adb and exec rejects, so read the error's stdout/stderr
    // rather than e.message (which only wraps "Command failed: adb ...").
    const rootOut = await pExecFile("adb", ["-s", emulatorSerial, "root"], { timeout: 10_000 })
      .then((r) => `${r.stdout}${r.stderr}`)
      .catch((e: unknown) => {
        const err = e as { stdout?: string; stderr?: string };
        return `${err.stdout ?? ""}${err.stderr ?? ""}`;
      });

    // Warn ONLY on positive evidence of a non-rootable image. Disconnects,
    // empty output, and unknown states stay silent (mock is optional).
    if (adbRootIndicatesNonRootable(rootOut)) {
      checks.push({
        id: "android-emulator-rootable",
        title: "Android Emulator Rootable Image",
        status: "warn",
        message: `network mock requires a rootable (non-Play) image — emulator ${emulatorSerial} returned: "${rootOut.trim()}"`,
      });
    }
  } catch {
    // adb not available or unexpected error — skip silently (mock is optional)
  }
}

async function commandCheck(
  id: string,
  title: string,
  command: string,
  commandExists: (command: string) => Promise<boolean>,
  missingMessage: string,
): Promise<DoctorCheck> {
  const exists = await commandExists(command);
  return {
    id,
    title,
    status: exists ? "pass" : "warn",
    message: exists ? `${command} is available.` : missingMessage,
  };
}

function defaultCommandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`], { stdio: "ignore" });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
