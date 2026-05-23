import { AgentNode } from "../../domain/agent/AgentNode.js";
import type { AgentRepository } from "../../domain/repositories/index.js";
import { EventType, PlatformType } from "../../shared-kernel/enums/index.js";
import { asAgentId } from "../../shared-kernel/ids/index.js";
import { nowIso } from "../../shared-kernel/time/index.js";
import type { ReporterApplicationService } from "../reporter/ReporterApplicationService.js";

export class AgentRuntimeService {
  constructor(
    private readonly agentRepository: AgentRepository,
    private readonly reporter: ReporterApplicationService,
  ) {}

  async register(agentId: string): Promise<AgentNode> {
    const node = new AgentNode(
      asAgentId(agentId),
      { supportedPlatforms: [PlatformType.HARMONY], maxConcurrentTasks: 1 },
      true,
      nowIso(),
    );
    await this.agentRepository.save(node);
    await this.reporter.emit(EventType.AGENT_REGISTERED, { agentId: node.id });
    return node;
  }

  async heartbeat(): Promise<void> {
    const agent = await this.agentRepository.get();
    if (!agent) return;
    agent.lastHeartbeatAt = nowIso();
    agent.online = true;
    await this.agentRepository.save(agent);
    await this.reporter.emit(EventType.HEARTBEAT, { agentId: agent.id, healthy: true });
  }
}
