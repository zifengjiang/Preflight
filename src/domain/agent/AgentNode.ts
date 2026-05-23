import type { AgentId } from "../../shared-kernel/ids/index.js";
import type { AgentCapability } from "../../shared-kernel/value-objects/index.js";

export class AgentNode {
  constructor(
    public readonly id: AgentId,
    public readonly capability: AgentCapability,
    public online: boolean,
    public lastHeartbeatAt: string,
  ) {}
}
