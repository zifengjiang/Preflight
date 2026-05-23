import type { PlatformToAgentCommand } from "./index.js";

/** 传输层信封（WS / HTTP poll 共用），platform 生成 deliveryId */
export interface PlatformCommandEnvelope {
  protocolVersion?: number;
  deliveryId: string;
  issuedAt?: string;
  command: PlatformToAgentCommand;
}

function isCommandShape(value: unknown): value is PlatformToAgentCommand {
  if (!value || typeof value !== "object") return false;
  const t = (value as { type?: unknown }).type;
  return typeof t === "string" && t.length > 0;
}

/**
 * 解析入站 JSON：支持信封 `{ deliveryId, command }` 与旧版裸命令（仅 `command`）。
 */
export function parseInboundCommandJson(raw: string): { deliveryId?: string; command: PlatformToAgentCommand } {
  const parsed: unknown = JSON.parse(raw);
  if (parsed && typeof parsed === "object" && "command" in parsed) {
    const o = parsed as Record<string, unknown>;
    const cmd = o.command;
    const idRaw = o.deliveryId;
    if (isCommandShape(cmd) && typeof idRaw === "string" && idRaw.trim()) {
      return { deliveryId: idRaw.trim(), command: cmd };
    }
  }
  if (!isCommandShape(parsed)) {
    throw new Error("invalid command payload: missing type");
  }
  return { command: parsed };
}
