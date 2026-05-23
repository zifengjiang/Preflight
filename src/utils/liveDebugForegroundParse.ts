import type { LiveDebugForegroundApp } from "../domain/runtime/interfaces.js";

/**
 * 从 `adb shell dumpsys activity …` / `dumpsys window …` 等**小片段** stdout 解析当前前台包名（Android 包名写入 `bundleId` 字段以与 iOS 对齐）。
 */
export function parseAndroidForegroundFromDumpsys(text: string): LiveDebugForegroundApp | undefined {
  const lines = text.split("\n");
  for (const line of lines) {
    if (!line.includes("ResumedActivity") && !line.includes("resumed")) continue;
    const m = line.match(/ActivityRecord\{[^ ]+\s+u\d+\s+([^/\s]+)\//);
    if (m?.[1]) return { bundleId: m[1] };
  }
  for (const line of lines) {
    if (!line.includes("mCurrentFocus")) continue;
    const m = line.match(/mCurrentFocus=Window\{[^}]+\s(?:u0|u\d+)\s+([^/\s}]+)\//);
    if (m?.[1]) return { bundleId: m[1] };
  }
  const act = text.match(/^\s*ACTIVITY\s+([A-Za-z0-9_.]+)\//m);
  if (act?.[1]) return { bundleId: act[1] };
  return undefined;
}

function pickHarmonyBundleFromChunk(chunk: string): LiveDebugForegroundApp | undefined {
  const bundle =
    chunk.match(/"bundleName"\s*:\s*"([^"]+)"/)?.[1] ??
    chunk.match(/\bbundleName\s*=\s*"([^"]+)"/)?.[1] ??
    chunk.match(/\bbundleName\s*[:=]\s*([A-Za-z0-9_.]+)\b/i)?.[1];
  if (!bundle) return undefined;
  const name =
    chunk.match(/"appName"\s*:\s*"([^"]+)"/)?.[1] ??
    chunk.match(/\bappName\s*=\s*"([^"]+)"/)?.[1] ??
    chunk.match(/\bappName\s*[:=]\s*([^\r\n]+)/i)?.[1]?.trim();
  const pidM = chunk.match(/\b(?:pid|processId)\s*[:=]\s*(\d{2,8})\b/i);
  const pid = pidM?.[1] ? Number.parseInt(pidM[1], 10) : undefined;
  const out: LiveDebugForegroundApp = { bundleId: bundle };
  if (name) out.name = name.slice(0, 400);
  if (pid !== undefined && Number.isFinite(pid)) out.pid = pid;
  return out;
}

/**
 * 从鸿蒙 `aa dump` / `hidumper` 等 stdout 解析前台 bundle（写入 `bundleId`）。
 */
export function parseHarmonyForegroundFromShellDump(text: string): LiveDebugForegroundApp | undefined {
  const t = text.length > 800_000 ? text.slice(0, 800_000) : text;

  const fgIter = t.matchAll(/\b(?:FOREGROUND|STATE_FOREGROUND)\b/gi);
  for (const m of fgIter) {
    const pos = m.index ?? 0;
    const chunk = t.slice(Math.max(0, pos - 2500), Math.min(t.length, pos + 2500));
    const hit = pickHarmonyBundleFromChunk(chunk);
    if (hit) return hit;
  }

  const focusIdx = t.search(/(?:Focus|focus)(?:ed)?Window/i);
  if (focusIdx >= 0) {
    const w = t.slice(focusIdx, focusIdx + 1400);
    const bundle =
      w.match(/"bundleName"\s*:\s*"([^"]+)"/)?.[1] ??
      w.match(/\bbundleName\s*=\s*"([^"]+)"/)?.[1];
    if (bundle) {
      const name = w.match(/"appName"\s*:\s*"([^"]+)"/)?.[1] ?? w.match(/\bappName\s*=\s*"([^"]+)"/)?.[1];
      return name ? { bundleId: bundle, name: name.slice(0, 400) } : { bundleId: bundle };
    }
  }

  const top =
    t.match(/\btop(?:Mission|Ability)[^\n\r]{0,240}?(?:bundleName|bundle)\s*[:=]\s*\[?([A-Za-z0-9_.]+)\]?/i)?.[1] ??
    t.match(/\bmain(?:Ability)?BundleName\s*[:=]\s*\[?([A-Za-z0-9_.]+)\]?/i)?.[1];
  if (top) return { bundleId: top };

  return undefined;
}
