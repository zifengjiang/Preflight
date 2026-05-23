import type { DebugSession } from "./DebugSession.js";
import type { ExecutionSession } from "./ExecutionSession.js";

export class SessionManager {
  constructor(
    public readonly executionSessions: ExecutionSession[],
    public readonly debugSessions: DebugSession[],
  ) {}
}
