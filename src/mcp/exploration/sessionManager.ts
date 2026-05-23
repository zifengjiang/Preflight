import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { MidsceneSession } from "../../utils/midscene-device-session.js";
import type { ExplorationSessionState, Platform } from "./types.js";

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * In-memory session store. If the MCP server process is restarted between
 * tool calls, sessions are recovered from a backing JSON file on first access.
 */
const SESSIONS = new Map<string, ExplorationSessionState>();

// ---------------------------------------------------------------------------
// File-based session metadata (survives MCP server restart)
// ---------------------------------------------------------------------------

function sessionsDir(): string {
  return join(homedir(), ".preflight", "exploration-sessions");
}

function sessionFilePath(id: string): string {
  return join(sessionsDir(), `${id}.json`);
}

export interface SessionMeta {
  id: string;
  resourceId: string;
  platform: Platform;
  env: Record<string, string>;
  createdAt: number;
  lastActivityAt: number;
}

async function persistMeta(state: ExplorationSessionState, env: Record<string, string>): Promise<void> {
  const dir = sessionsDir();
  await mkdir(dir, { recursive: true });
  const meta: SessionMeta = {
    id: state.id,
    resourceId: state.resourceId,
    platform: state.platform,
    env,
    createdAt: state.createdAt,
    lastActivityAt: state.lastActivityAt,
  };
  await writeFile(sessionFilePath(state.id), JSON.stringify(meta, null, 2), "utf8");
}

export async function loadMeta(id: string): Promise<SessionMeta | null> {
  try {
    const text = await readFile(sessionFilePath(id), "utf8");
    return JSON.parse(text) as SessionMeta;
  } catch {
    return null;
  }
}

async function removeMeta(id: string): Promise<void> {
  try {
    await unlink(sessionFilePath(id));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/** Create a new exploration session and persist metadata to disk. */
export function createSession(
  id: string,
  resourceId: string,
  platform: Platform,
  session: MidsceneSession,
  env: Record<string, string>,
): ExplorationSessionState {
  const state: ExplorationSessionState = {
    id,
    resourceId,
    platform,
    session,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };
  SESSIONS.set(id, state);
  persistMeta(state, env).catch(() => {});
  return state;
}

/**
 * Get a session from memory. Throws if not found — caller should fall back
 * to `restoreSession` for recovery across server restarts.
 */
export function getSession(id: string): ExplorationSessionState {
  const state = SESSIONS.get(id);
  if (!state) {
    throw new Error(`Exploration session not found: ${id}. Call exploration_start first.`);
  }
  if (Date.now() - state.lastActivityAt > SESSION_TIMEOUT_MS) {
    void destroySession(state);
    throw new Error(`Exploration session ${id} has expired (30 min timeout). Call exploration_start again.`);
  }
  state.lastActivityAt = Date.now();
  return state;
}

/**
 * Store a recreated session in memory (used by tools that recover from disk metadata).
 */
export function storeSession(id: string, session: MidsceneSession, meta: SessionMeta): ExplorationSessionState {
  const state: ExplorationSessionState = {
    id,
    resourceId: meta.resourceId,
    platform: meta.platform,
    session,
    createdAt: meta.createdAt,
    lastActivityAt: Date.now(),
  };
  SESSIONS.set(id, state);
  return state;
}

/** Destroy a session: remove from map + backing file, release device connection. */
export async function destroySession(state: ExplorationSessionState): Promise<void> {
  SESSIONS.delete(state.id);
  await removeMeta(state.id);
  try {
    await state.session.device.destroy();
  } catch {
    // ignore cleanup errors
  }
}

/** Look up a session by ID and destroy it. No-op if session does not exist. */
export async function destroySessionById(id: string): Promise<void> {
  const state = SESSIONS.get(id);
  if (!state) {
    await removeMeta(id); // clean up orphaned meta
    return;
  }
  await destroySession(state);
}

export function hasSession(id: string): boolean {
  return SESSIONS.has(id);
}

export function activeSessionCount(): number {
  return SESSIONS.size;
}
