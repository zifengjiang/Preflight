import type { ExplorationToolContext } from "./types.js";
import { resolveSession } from "./tools-session.js";

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
    return { summary };
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
    await session.agent.aiAct(input.intent);
    const afterSummary = await session.agent.aiAsk(
      "刚刚的操作已完成。请判断：\n" +
      "1) 操作是否改变了页面内容？（新页面、弹窗、滚动到底部、输入框获得焦点等）\n" +
      "2) 如果操作是滑动页面，是否滑到了底部或页面内容没有变化？\n" +
      "3) 当前页面布局类型是固定单屏还是可滚动长页面？\n" +
      "4) 当前页面出现的最关键变化是什么？\n" +
      "如果你发现操作没有产生任何实际变化（比如反复滑动但没有新内容），请明确指出\"页面没有变化\"。",
    );
    return { ok: true, summary: afterSummary };
  };
}
