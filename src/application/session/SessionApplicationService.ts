import { DebugSession } from "../../domain/session/DebugSession.js";
import { ExecutionSession } from "../../domain/session/ExecutionSession.js";
import type { SessionRepository } from "../../domain/repositories/index.js";
import {
  asLeaseId,
  asResourceId,
  asSessionId,
  type LeaseId,
  type ResourceId,
  type SessionId,
} from "../../shared-kernel/ids/index.js";
import { SessionStatus, type OwnerType } from "../../shared-kernel/enums/index.js";

export class SessionApplicationService {
  constructor(private readonly sessionRepository: SessionRepository) {}

  async createExecution(
    sessionId: string,
    resourceId: ResourceId,
    leaseId: LeaseId,
    ownerId: string,
    ownerType: OwnerType,
  ): Promise<ExecutionSession> {
    const session = new ExecutionSession(
      asSessionId(sessionId),
      resourceId,
      leaseId,
      ownerId,
      ownerType,
      SessionStatus.CREATED,
    );
    await this.sessionRepository.saveExecution(session);
    return session;
  }

  async createDebug(
    sessionId: string,
    resourceId: string,
    leaseId: string,
    ownerId: string,
    ownerType: OwnerType,
  ): Promise<DebugSession> {
    const session = new DebugSession(
      asSessionId(sessionId),
      asResourceId(resourceId),
      asLeaseId(leaseId),
      ownerId,
      ownerType,
      SessionStatus.CREATED,
    );
    await this.sessionRepository.saveDebug(session);
    return session;
  }

  async closeExecution(sessionId: SessionId): Promise<ExecutionSession | null> {
    const session = await this.sessionRepository.getExecutionById(sessionId);
    if (!session) return null;
    session.status = SessionStatus.CLOSED;
    await this.sessionRepository.saveExecution(session);
    return session;
  }

  async closeDebug(sessionId: SessionId): Promise<DebugSession | null> {
    const session = await this.sessionRepository.getDebugById(sessionId);
    if (!session) return null;
    session.status = SessionStatus.CLOSED;
    await this.sessionRepository.saveDebug(session);
    return session;
  }

  async getDebug(sessionId: SessionId): Promise<DebugSession | null> {
    return this.sessionRepository.getDebugById(sessionId);
  }
}
