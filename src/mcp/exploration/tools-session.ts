import { readFile } from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Platform } from "./types.js";
import type { ExplorationToolContext } from "./types.js";
import { createSession, getSession, destroySession, destroySessionById } from "./sessionManager.js";
import { createMidsceneSession } from "../../utils/midscene-device-session.js";
import type { MidsceneSession } from "../../utils/midscene-device-session.js";

// ---------------------------------------------------------------------------
// Auto-discover WDA port from watchdog state file
// ---------------------------------------------------------------------------

async function discoverWdaPort(deviceId: string): Promise<number | null> {
  const statePath = process.env.IOS_WDA_PORT_MAP_FILE_PATH
    || path.join(homedir(), ".preflight", "runtime", ".wda-agent-state", "wda-port-map.json");
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as { portsByUdid?: Record<string, number> };
    const port = parsed?.portsByUdid?.[deviceId];
    if (port && Number.isFinite(port) && port > 0) return Math.floor(port);
  } catch {
    // state file not found or malformed — will use default port
  }
  return null;
}

// ---------------------------------------------------------------------------
// WDA health check and auto-start for iOS exploration
// ---------------------------------------------------------------------------

async function checkWdaHealth(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = http.get(`http://${host}:${port}/status`, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve(body.trim().length > 0));
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

export interface IosWdaStartResult {
  ok: boolean;
  message: string;
  host: string;
  port: number;
}

/**
 * Ensure WebDriverAgent is running for the given iOS device.
 * If already healthy, returns immediately. Otherwise invokes start-ios-wda.sh
 * and waits up to 120s for it to become ready.
 */
export async function ensureIosWdaStarted(
  resourceId: string,
  runtimeEnv: Record<string, string>,
  projectRoot?: string,
): Promise<IosWdaStartResult> {
  const host = runtimeEnv.MIDSCENE_IOS_WDA_HOST || "127.0.0.1";
  const defaultPort = Number(runtimeEnv.MIDSCENE_IOS_WDA_PORT) || 8200;
  const udid = extractDeviceValue(resourceId);

  // Discover port from watchdog port map, else use default
  const discoveredPort = udid ? await discoverWdaPort(udid) : null;
  const port = discoveredPort ?? defaultPort;

  // Already healthy?
  if (await checkWdaHealth(host, port, 2000)) {
    return { ok: true, message: `WebDriverAgent is already healthy on ${host}:${port}.`, host, port };
  }

  // Resolve start-ios-wda.sh script path
  const resolvedProjectRoot = projectRoot || process.cwd();
  const scriptPath = path.join(resolvedProjectRoot, "scripts", "start-ios-wda.sh");

  if (!udid) {
    return { ok: false, message: "Cannot start WDA: no iOS device UDID found in resourceId.", host, port };
  }

  // Start WDA via script
  return new Promise<IosWdaStartResult>((resolve) => {
    const child = spawn("/bin/bash", [scriptPath, udid, String(port)], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });

    child.on("close", async (code) => {
      if (code === 0) {
        // Script succeeded — now wait for WDA to be actually healthy
        for (let attempt = 0; attempt < 30; attempt++) {
          if (await checkWdaHealth(host, port, 1000)) {
            resolve({ ok: true, message: `WebDriverAgent started successfully on ${host}:${port}.`, host, port });
            return;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        resolve({
          ok: false,
          message: `start-ios-wda.sh exited 0 but WDA not healthy on ${host}:${port} after 30s. stdout: ${stdout.slice(0, 500)}`,
          host, port,
        });
      } else {
        resolve({
          ok: false,
          message: `start-ios-wda.sh exited code ${code}. stderr: ${stderr.slice(0, 300)}`,
          host, port,
        });
      }
    });

    child.on("error", (err) => {
      resolve({
        ok: false,
        message: `Failed to start WDA script: ${err.message}`,
        host, port,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Exported helpers (used by other exploration tools for session recovery)
// ---------------------------------------------------------------------------

export function generateSessionId(): string {
  return `explore-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function parsePlatform(resourceId: string): Platform {
  const colonIdx = resourceId.indexOf(":");
  if (colonIdx < 0) {
    throw new Error(`Invalid resourceId format: "${resourceId}". Expected "platform:id"`);
  }
  const prefix = resourceId.slice(0, colonIdx);
  switch (prefix) {
    case "android":
      return "ANDROID";
    case "ios":
      return "IOS";
    case "harmony":
      return "HARMONY";
    default:
      throw new Error(`Unknown platform prefix in resourceId: "${resourceId}"`);
  }
}

function extractDeviceValue(resourceId: string): string {
  const colonIdx = resourceId.indexOf(":");
  return colonIdx >= 0 ? resourceId.slice(colonIdx + 1) : "";
}

export async function createMidsceneSessionFromResourceId(
  resourceId: string,
  runtimeEnv: Record<string, string>,
): Promise<MidsceneSession> {
  const platform = parsePlatform(resourceId);
  const value = extractDeviceValue(resourceId);

  switch (platform) {
    case "ANDROID": {
      const adbPortRaw = runtimeEnv.MIDSCENE_ANDROID_ADB_PORT;
      const adbPort = adbPortRaw ? Number(adbPortRaw) : 5037;
      return createMidsceneSession({
        platform: "android",
        serial: value || undefined,
        adbHost: runtimeEnv.MIDSCENE_ANDROID_ADB_HOST ?? "127.0.0.1",
        adbPort,
      });
    }
    case "IOS": {
      const udid = value || undefined;
      const discoveredPort = await discoverWdaPort(udid || "");
      const wdaPort = runtimeEnv.MIDSCENE_IOS_WDA_PORT
        ? Number(runtimeEnv.MIDSCENE_IOS_WDA_PORT)
        : discoveredPort ?? 8200;
      const logPort = wdaPort === discoveredPort ? `${wdaPort} (discovered)` : `${wdaPort} (default)`;
      console.log(`[ios-target] ${udid || "auto"} WDA port: ${logPort}`);
      return createMidsceneSession({
        platform: "ios",
        deviceId: udid,
        wdaHost: runtimeEnv.MIDSCENE_IOS_WDA_HOST ?? "127.0.0.1",
        wdaPort,
      });
    }
    case "HARMONY":
      return createMidsceneSession({
        platform: "harmony",
        deviceId: value || undefined,
        hdcPath: runtimeEnv.MIDSCENE_HARMONY_HDC_PATH || undefined,
      });
    default:
      const _exhaustive: never = platform;
      throw new Error(`Unsupported platform: ${_exhaustive}`);
  }
}

function isInstallableRef(appRef: string): boolean {
  const lower = appRef.toLowerCase();
  return (
    lower.startsWith("http") ||
    lower.startsWith("file") ||
    lower.endsWith(".apk") ||
    lower.endsWith(".ipa")
  );
}

// ---------------------------------------------------------------------------
// Session manager helpers (shared across all exploration tools)
// ---------------------------------------------------------------------------

/**
 * Resolve a session by ID, with automatic recovery across MCP server restarts.
 * 1. Try in-memory lookup (fast path)
 * 2. If not found, try to load session metadata from disk
 * 3. If metadata found, re-create the device connection using the context factory
 * 4. Store the recovered session in memory for subsequent calls
 */
export async function resolveSession(
  id: string,
  ctx: ExplorationToolContext,
): Promise<MidsceneSession> {
  try {
    const state = getSession(id);
    return state.session;
  } catch {
    // Session not in memory — try to recover from disk
  }

  const { loadMeta, storeSession } = await import("./sessionManager.js");
  const meta = await loadMeta(id);
  if (!meta) {
    throw new Error(`Exploration session not found: ${id}. Call exploration_start first.`);
  }

  // Inject env vars for the Midscene SDK
  for (const [key, value] of Object.entries(meta.env)) {
    if (value !== undefined && !(key in process.env)) {
      process.env[key] = value;
    }
  }

  const session = await createMidsceneSessionFromResourceId(meta.resourceId, meta.env);
  storeSession(id, session, meta);
  return session;
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

export function getExplorationStartHandler(ctx: ExplorationToolContext) {
  return async (input: { resourceId?: string; appRef?: string }) => {
    await ctx.ensureAgentStarted();

    const configEnv = await ctx.loadConfigEnv();
    const runtimeEnv: Record<string, string> = { ...configEnv };
    for (const [key, value] of Object.entries(runtimeEnv)) {
      if (value !== undefined && !(key in process.env)) {
        process.env[key] = value;
      }
    }

    let resourceId = input.resourceId;
    if (!resourceId) {
      const devices = await ctx.client.listDevices();
      if (devices.length === 0) {
        throw new Error("No devices available. Provide a resourceId or connect a device first.");
      }
      resourceId = devices[0].id;
    }

    const platform = parsePlatform(resourceId);

    // Auto-start WDA for iOS if not running
    if (platform === "IOS") {
      const wdaResult = await ensureIosWdaStarted(resourceId, runtimeEnv, ctx.projectRoot);
      if (!wdaResult.ok) {
        throw new Error(
          `iOS WebDriverAgent is not running and could not be auto-started: ${wdaResult.message}. ` +
          `Call "start_ios_wda" tool explicitly if needed.`,
        );
      }
    }

    const session = await createMidsceneSessionFromResourceId(resourceId, runtimeEnv);

    const sessionId = generateSessionId();
    const appRef = input.appRef;
    createSession(sessionId, resourceId, platform, session, runtimeEnv, appRef);

    try {
      if (appRef) {
        if (isInstallableRef(appRef)) {
          await ctx.client.installApp(resourceId, appRef);
          return {
            sessionId,
            device: { platform, resourceId },
            note: `App installed from ${appRef}. Use exploration_ai_act to launch it.`,
          };
        }
        await session.agent.launch(appRef);
      }
    } catch (err) {
      await destroySessionById(sessionId).catch(() => {});
      throw err;
    }

    return { sessionId, device: { platform, resourceId }, appRef: appRef ?? undefined };
  };
}

export function getExplorationEndHandler() {
  return async (input: { sessionId: string }) => {
    try {
      const state = getSession(input.sessionId);
      await destroySession(state);
    } catch {
      // Session may already be expired or destroyed — always return ok
    }
    return { ok: true };
  };
}
