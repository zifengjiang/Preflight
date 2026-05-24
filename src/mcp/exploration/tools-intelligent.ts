import http from "node:http";
import { execSync } from "node:child_process";
import type { ExplorationToolContext } from "./types.js";
import { resolveSession } from "./tools-session.js";
import type { MidsceneSession } from "../../utils/midscene-device-session.js";
import { getSession } from "./sessionManager.js";

// ---------------------------------------------------------------------------
// Foreground app detection helpers
// ---------------------------------------------------------------------------

interface AppDetectionResult {
  bundleId: string;
  name?: string;
}

async function detectIosForegroundApp(session: MidsceneSession): Promise<AppDetectionResult | null> {
  if (session.platform !== "ios") return null;
  const { wdaHost, wdaPort } = session.target;
  return new Promise<AppDetectionResult | null>((resolve) => {
    const req = http.get(`http://${wdaHost}:${wdaPort}/wda/activeAppInfo`, { timeout: 3000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const data = JSON.parse(body) as { value?: { bundleId?: string; name?: string } };
          if (data?.value?.bundleId) {
            resolve({ bundleId: data.value.bundleId, name: data.value.name });
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

function detectAndroidForegroundApp(session: MidsceneSession): AppDetectionResult | null {
  if (session.platform !== "android") return null;
  const { serial, adbHost, adbPort } = session.target;
  try {
    const output = execSync(
      `adb -H ${adbHost} -P ${adbPort} -s ${serial} shell dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp'`,
      { encoding: "utf8", timeout: 5000 },
    );
    // Match patterns like:
    //   mCurrentFocus=Window{... com.example.app/...}
    //   mFocusedApp=AppWindowToken{... token=... appPackageName=com.example.app}
    const focusMatch = output.match(/mCurrentFocus[=:].*?\s+([^\s/}]+)/);
    const packageMatch = output.match(/appPackageName=([^\s}]+)/);
    if (focusMatch) return { bundleId: focusMatch[1] };
    if (packageMatch) return { bundleId: packageMatch[1] };
  } catch {
    // adb not reachable or no foreground window
  }
  return null;
}

async function detectForegroundApp(
  session: MidsceneSession,
): Promise<{ bundleId: string; name?: string } | null> {
  if (session.platform === "ios") return detectIosForegroundApp(session);
  if (session.platform === "android") return detectAndroidForegroundApp(session);
  return null;
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

export function getPageSummaryHandler(ctx: ExplorationToolContext) {
  return async (input: { sessionId: string }): Promise<unknown> => {
    const session = await resolveSession(input.sessionId, ctx);
    const summary = await session.agent.aiAsk(
      "详细描述当前页面。请按从上到下的顺序列出所有可见区域、交互元素和文案。\n" +
      "特别注意：\n" +
      "1) 页面底部是否有更多内容（是否可滚动）？如果底部紧贴导航栏/状态栏则说明是固定单屏布局\n" +
      "2) 是否有弹窗、广告或遮挡物？\n" +
      "3) 整体布局类型：固定单屏 / 可滚动长页面 / 多Tab / 列表\n" +
      "先判断布局类型，再逐一描述每个区域的内容。",
    );

    const state = getSession(input.sessionId);
    const foregroundApp = await detectForegroundApp(session);
    const appRef = state.appRef;

    // Save for aiActHandler's before/after comparison
    state.lastPageSummary = summary;

    return {
      summary,
      app: {
        platform: session.platform,
        resourceId: state.resourceId,
        ...(appRef ? { appRef } : {}),
        ...(foregroundApp ? { foregroundApp } : {}),
      },
    };
  };
}

export function askAboutScreenHandler(ctx: ExplorationToolContext) {
  return async (input: { sessionId: string; question: string }): Promise<unknown> => {
    const session = await resolveSession(input.sessionId, ctx);
    const answer = await session.agent.aiAsk(input.question);
    return { answer };
  };
}

export function aiActHandler(ctx: ExplorationToolContext) {
  return async (input: { sessionId: string; intent: string }): Promise<unknown> => {
    const session = await resolveSession(input.sessionId, ctx);
    const state = getSession(input.sessionId);

    // Before-state: reuse from get_page_summary if available, otherwise grab a quick one
    const beforeSummary = state.lastPageSummary ?? await session.agent.aiAsk(
      "用一句话描述当前页面的最关键特征：什么类型的页面（列表/表单/弹窗/首页等），最显著的内容是什么。",
    );

    await session.agent.aiAct(input.intent);

    const afterSummary = await session.agent.aiAsk(
      `操作前的页面：${beforeSummary}\n` +
      `执行的操作：${input.intent}\n` +
      "请判断操作结果：\n" +
      "1) 页面内容是否发生了变化？（进入了新页面、弹出弹窗、滚动到底部、输入框获得焦点等）\n" +
      "2) 如果操作是滑动，是否已到达底部或页面没有变化？\n" +
      "3) 当前页面布局类型是固定单屏还是可滚动长页面？\n" +
      "4) 当前页面最关键的变化是什么？\n" +
      "如果操作没有产生任何实际变化（比如反复滑动但没有新内容），请明确指出\"页面没有变化\"。",
    );

    // Update for next aiAct call
    state.lastPageSummary = afterSummary;

    const foregroundApp = await detectForegroundApp(session);

    return {
      ok: true,
      summary: afterSummary,
      app: {
        platform: session.platform,
        resourceId: state.resourceId,
        ...(state.appRef ? { appRef: state.appRef } : {}),
        ...(foregroundApp ? { foregroundApp } : {}),
      },
    };
  };
}
