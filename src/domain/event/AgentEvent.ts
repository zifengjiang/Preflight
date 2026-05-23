import type { EventType } from "../../shared-kernel/enums/index.js";

export class AgentEvent {
  constructor(
    public readonly type: EventType,
    public readonly timestamp: string,
    public readonly payload: Record<string, unknown>,
  ) {}
}
