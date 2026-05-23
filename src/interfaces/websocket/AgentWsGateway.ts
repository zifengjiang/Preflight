import type { AppPackageApplicationService } from "../../application/app-package/AppPackageApplicationService.js";
import type { DebugApplicationService } from "../../application/debug/DebugApplicationService.js";
import type { LeaseApplicationService } from "../../application/lease/LeaseApplicationService.js";
import type { ResourceOccupationReleaseService } from "../../application/resource/ResourceOccupationReleaseService.js";
import type { TaskApplicationService } from "../../application/task/TaskApplicationService.js";
import type { PlatformToAgentCommand } from "../../protocol-contracts/commands/index.js";
import { parseInboundCommandJson } from "../../protocol-contracts/commands/envelope.js";
import { DeliveryIdDeduper } from "../../infrastructure/resilience/DeliveryIdDeduper.js";
import { asLeaseId, asSessionId, asTaskId } from "../../shared-kernel/ids/index.js";
import { WsClient } from "../../infrastructure/transport/ws/WsClient.js";

export class AgentWsGateway {
  private commandChain: Promise<void> = Promise.resolve();
  private readonly deduper: DeliveryIdDeduper;

  private onCommandError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[AgentWsGateway] command failed: ${message}`);
  }

  private summarizeCommand(command: PlatformToAgentCommand): string {
    if (command.type === "CreateTaskCommand") {
      return JSON.stringify({
        type: command.type,
        taskId: command.taskId,
        requiredPlatform: command.requiredPlatform,
        resourceId: command.resourceId ?? "",
        selector: command.selector ?? null,
        scriptLength: command.script?.length ?? 0,
        runtimeEnvKeys: Object.keys(command.runtimeEnv ?? {}).length,
      });
    }
    if (command.type === "AcquireLeaseCommand") {
      return JSON.stringify({
        type: command.type,
        leaseId: command.leaseId,
        resourceId: command.resourceId,
        ownerId: command.ownerId,
        ownerType: command.ownerType,
        ttlSeconds: command.ttlSeconds,
      });
    }
    if (command.type === "StartLiveDebugSessionCommand") {
      return JSON.stringify({
        type: command.type,
        sessionId: command.sessionId,
        resourceId: command.resourceId,
        frameIntervalMs: command.frameIntervalMs ?? null,
      });
    }
    if (command.type === "SendLiveDebugInputCommand") {
      return JSON.stringify({
        type: command.type,
        sessionId: command.sessionId,
        action: command.action,
      });
    }
    if (command.type === "InstallAppCommand") {
      const ref = command.appRef ?? "";
      const summarized =
        /^https?:\/\//i.test(ref.trim()) ? `http(s) url (length=${ref.length})` : ref.length > 160 ? `${ref.slice(0, 160)}…` : ref;
      return JSON.stringify({
        type: command.type,
        resourceId: command.resourceId,
        appRef: summarized,
      });
    }
    if (command.type === "UninstallAppCommand") {
      return JSON.stringify({
        type: command.type,
        resourceId: command.resourceId,
        bundleId: command.bundleId,
      });
    }
    return JSON.stringify(command);
  }

  constructor(
    private readonly wsClient: WsClient,
    private readonly leaseService: LeaseApplicationService,
    private readonly taskService: TaskApplicationService,
    private readonly debugService: DebugApplicationService,
    private readonly appPackageService: AppPackageApplicationService,
    private readonly occupationRelease: ResourceOccupationReleaseService,
    deduperMaxSize = 4096,
  ) {
    this.deduper = new DeliveryIdDeduper(deduperMaxSize);
  }

  /** HTTP poll：返回是否重复投递（仍应对应 ACK），以及是否处理失败 */
  async handlePollDelivery(item: {
    deliveryId: string;
    command: PlatformToAgentCommand;
  }): Promise<{ duplicate: boolean; ok: boolean }> {
    const { deliveryId, command } = item;
    if (this.deduper.isProcessed(deliveryId)) {
      return { duplicate: true, ok: true };
    }
    try {
      await this.ingestCommand(command, deliveryId, { mode: "awaitAll" });
      return { duplicate: false, ok: true };
    } catch (error: unknown) {
      this.onCommandError(error);
      return { duplicate: false, ok: false };
    }
  }

  start(): void {
    this.wsClient.onMessage(async (raw) => {
      try {
        const { deliveryId, command } = parseInboundCommandJson(raw);
        console.info(`[AgentWsGateway] received command=${this.summarizeCommand(command)}`);
        await this.ingestCommand(command, deliveryId, { mode: "ws" });
      } catch (error: unknown) {
        this.onCommandError(error);
      }
    });
    this.wsClient.connect();
  }

  /**
   * mode ws：CreateTask 不阻塞后续 WS 消息；awaitAll：poll 路径一律等待 route 完成（含长任务）。
   */
  private async ingestCommand(
    command: PlatformToAgentCommand,
    deliveryId: string | undefined,
    opts: { mode: "ws" | "awaitAll" },
  ): Promise<void> {
    if (deliveryId && this.deduper.isProcessed(deliveryId)) {
      console.info(`[AgentWsGateway] skip duplicate deliveryId=${deliveryId}`);
      return;
    }

    const finish = async (): Promise<void> => {
      await this.route(command);
      if (deliveryId) this.deduper.markProcessed(deliveryId);
    };

    const fireAndForget =
      opts.mode === "ws" &&
      (command.type === "CreateTaskCommand" ||
        command.type === "InstallAppCommand" ||
        command.type === "UninstallAppCommand");

    if (fireAndForget) {
      void finish().catch((error: unknown) => this.onCommandError(error));
      return;
    }

    if (opts.mode === "ws" && command.type !== "CreateTaskCommand") {
      this.commandChain = this.commandChain
        .then(() => finish())
        .catch((error: unknown) => this.onCommandError(error));
      await this.commandChain;
      return;
    }

    await finish();
  }

  private async route(command: PlatformToAgentCommand): Promise<void> {
    switch (command.type) {
      case "AcquireLeaseCommand":
        await this.leaseService.acquire(
          command.leaseId,
          command.resourceId,
          command.ownerId,
          command.ownerType,
          command.ttlSeconds,
          {
            username: command.occupantUsername,
            displayName: command.occupantDisplayName,
          },
        );
        return;
      case "RenewLeaseCommand":
        await this.leaseService.renew(asLeaseId(command.leaseId), command.ttlSeconds);
        return;
      case "ReleaseLeaseCommand":
        await this.leaseService.release(asLeaseId(command.leaseId));
        return;
      case "RevokeLeaseByResourceCommand":
        await this.occupationRelease.forceRelease(command.resourceId);
        return;
      case "CreateTaskCommand":
        await this.taskService.dispatch(command);
        return;
      case "CancelTaskCommand":
        await this.taskService.cancel(asTaskId(command.taskId));
        return;
      case "CreateDebugSessionCommand":
        await this.debugService.createDebugSession({
          sessionId: command.sessionId,
          resourceId: command.resourceId,
          leaseId: `lease-${command.sessionId}`,
          ownerId: command.ownerId,
        });
        return;
      case "SendDebugCommand":
        await this.debugService.sendCommand(command.sessionId, command.command);
        return;
      case "CloseDebugSessionCommand":
        await this.debugService.close(asSessionId(command.sessionId));
        return;
      case "StartLiveDebugSessionCommand":
        await this.debugService.startLiveSession({
          sessionId: command.sessionId,
          resourceId: command.resourceId,
          frameIntervalMs: command.frameIntervalMs,
        });
        return;
      case "SendLiveDebugInputCommand":
        if (command.action === "tap") {
          await this.debugService.sendLiveInput(command.sessionId, {
            action: "tap",
            x: command.x ?? 0,
            y: command.y ?? 0,
            coordinateSpace: command.coordinateSpace,
            sourceWidth: command.sourceWidth,
            sourceHeight: command.sourceHeight,
          });
          return;
        }
        if (command.action === "swipe") {
          await this.debugService.sendLiveInput(command.sessionId, {
            action: "swipe",
            x: command.x ?? 0,
            y: command.y ?? 0,
            x2: command.x2 ?? 0,
            y2: command.y2 ?? 0,
            durationMs: command.durationMs,
            coordinateSpace: command.coordinateSpace,
            sourceWidth: command.sourceWidth,
            sourceHeight: command.sourceHeight,
          });
          return;
        }
        await this.debugService.sendLiveInput(command.sessionId, {
          action: "key",
          key: command.key ?? "",
        });
        return;
      case "StopLiveDebugSessionCommand":
        await this.debugService.stopLiveSession(command.sessionId);
        return;
      case "InstallAppCommand":
        await this.appPackageService.install(command.resourceId, command.appRef);
        return;
      case "UninstallAppCommand":
        await this.appPackageService.uninstall(command.resourceId, command.bundleId);
        return;
      default:
        return;
    }
  }
}
