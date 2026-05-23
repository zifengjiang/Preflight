import type { HealthMetricsService } from "../health/HealthMetricsService.js";
import type { PlatformCommandPollClient } from "../../infrastructure/transport/http/PlatformCommandPollClient.js";
import type { WsClient } from "../../infrastructure/transport/ws/WsClient.js";
import type { AgentWsGateway } from "../../interfaces/websocket/AgentWsGateway.js";

/** WS 未连接时拉取平台待下发命令并 ACK */
export class AgentCommandPollLoop {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pollClient: PlatformCommandPollClient,
    private readonly gateway: AgentWsGateway,
    private readonly wsClient: WsClient,
    private readonly health: HealthMetricsService,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (!this.pollClient.isEnabled()) return;
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => {}), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (!this.pollClient.isEnabled()) return;
    if (this.wsClient.isOpen()) return;
    try {
      const items = await this.pollClient.fetchPending(20);
      for (const item of items) {
        const result = await this.gateway.handlePollDelivery(item);
        if (result.ok || result.duplicate) {
          await this.pollClient.ack([item.deliveryId]);
        }
      }
      this.health.markPollOk();
    } catch {
      this.health.markPollError();
    }
  }
}
