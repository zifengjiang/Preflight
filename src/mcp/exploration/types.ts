import type { AgentHttpClient } from "../agentHttpClient.js";
import type { MidsceneSession } from "../../utils/midscene-device-session.js";

export type Platform = "ANDROID" | "IOS" | "HARMONY";

export interface ExplorationSessionState {
  id: string;
  resourceId: string;
  platform: Platform;
  session: MidsceneSession;
  appRef?: string;
  lastPageSummary?: string;
  createdAt: number;
  lastActivityAt: number;
}

export interface ExplorationToolContext {
  client: AgentHttpClient;
  loadConfigEnv: () => Promise<Record<string, string>>;
  ensureAgentStarted: () => Promise<void>;
  /** Re-create a device session from metadata (survives MCP server restarts). */
  createSessionFromMeta: (resourceId: string, runtimeEnv: Record<string, string>) => Promise<MidsceneSession>;
  /** Project root directory for resolving script paths (e.g. start-ios-wda.sh). */
  projectRoot?: string;
}
