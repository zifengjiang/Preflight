import type { ExplorationToolContext } from "./types.js";
import { resolveSession } from "./tools-session.js";

/**
 * Parse a data URI and return the base64 payload and MIME type.
 * Falls back to `mimeType: "unknown"` when the data URI cannot be parsed.
 */
function parseDataUri(uri: string): { screenshot: string; mimeType: string } {
  const match = /^data:([^;]+);base64,(.+)$/.exec(uri);
  if (!match) {
    return { screenshot: uri, mimeType: "unknown" };
  }
  return { screenshot: match[2], mimeType: match[1] };
}

export function getScreenshotHandler(ctx: ExplorationToolContext) {
  return async (input: { sessionId: string }): Promise<{ screenshot: string; mimeType: string }> => {
    const session = await resolveSession(input.sessionId, ctx);
    const rawDataUri = await session.device.screenshotBase64();
    return parseDataUri(rawDataUri);
  };
}

export function getTypeHandler(ctx: ExplorationToolContext) {
  return async (input: { sessionId: string; text: string }): Promise<unknown> => {
    const session = await resolveSession(input.sessionId, ctx);
    await session.agent.aiAct(`输入 ${input.text}`);
    return { ok: true };
  };
}

export function getWaitHandler(ctx: ExplorationToolContext) {
  return async (input: { sessionId: string; ms: number }): Promise<unknown> => {
    const session = await resolveSession(input.sessionId, ctx);
    const clamped = Math.max(0, Math.min(input.ms, 10000));
    await new Promise((r) => setTimeout(r, clamped));
    return { ok: true };
  };
}
