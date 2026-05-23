import type { AgentEvent } from "./AgentEvent.js";

export class Reporter {
  constructor(public readonly events: AgentEvent[]) {}
}
