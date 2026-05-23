import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AppPackageApplicationService } from "../../application/app-package/AppPackageApplicationService.js";
import type { AppPackageUrlCache } from "../../infrastructure/app-package/AppPackageUrlCache.js";
import type { LeaseApplicationService } from "../../application/lease/LeaseApplicationService.js";
import type { ResourceOccupationReleaseService } from "../../application/resource/ResourceOccupationReleaseService.js";
import type { TaskApplicationService } from "../../application/task/TaskApplicationService.js";
import type { ResourceRegistryService } from "../../application/resource/ResourceRegistryService.js";
import type { HealthMetricsService } from "../../application/health/HealthMetricsService.js";
import type { ObservationQueryService } from "../../application/query/ObservationQueryService.js";
import type { PlatformToAgentCommand } from "../../protocol-contracts/commands/index.js";
import { LeaseConflictError } from "../../shared-kernel/errors/index.js";
import { OwnerType } from "../../shared-kernel/enums/index.js";
import { asLeaseId, asTaskId } from "../../shared-kernel/ids/index.js";

export class HttpServer {
  constructor(
    private readonly resourceService: ResourceRegistryService,
    private readonly observationQueryService: ObservationQueryService,
    private readonly healthService: HealthMetricsService,
    private readonly port: number,
    private readonly authToken?: string,
    private readonly agentId?: string,
    private readonly leaseService?: LeaseApplicationService,
    private readonly taskService?: TaskApplicationService,
    private readonly appPackageService?: AppPackageApplicationService,
    private readonly occupationRelease?: ResourceOccupationReleaseService,
    private readonly appPackageUrlCache?: AppPackageUrlCache,
  ) {}

  start(): import("node:http").Server {
    const server = createServer(async (req, res) => {
      if (!req.url) return this.writeJson(res, 404, { message: "not found" });
      if (this.authToken) {
        const auth = req.headers.authorization ?? "";
        const expected = `Bearer ${this.authToken}`;
        if (auth !== expected) {
          return this.writeJson(res, 401, { message: "unauthorized" });
        }
      }
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/platform/commands" && req.method === "POST") {
        return this.handlePlatformCommand(req, res);
      }
      if (url.pathname === "/health") return this.writeJson(res, 200, this.healthService.snapshot());
      if (url.pathname === "/metrics") return this.writeJson(res, 200, this.healthService.snapshot());
      if (url.pathname === "/cached-app-packages" && req.method === "GET") {
        if (!this.appPackageUrlCache) {
          return this.writeJson(res, 503, { message: "app package url cache unavailable" });
        }
        const snap = await this.appPackageUrlCache.snapshotForHttp();
        return this.writeJson(res, 200, snap);
      }
      if (url.pathname === "/resources") {
        const forceRefresh = url.searchParams.get("refresh") !== "0";
        if (forceRefresh) {
          await this.resourceService.refresh();
        }
        const resources = await this.resourceService.list();
        if (!this.agentId) return this.writeJson(res, 200, resources);
        return this.writeJson(
          res,
          200,
          resources.map((item) => ({ ...item, agentId: this.agentId })),
        );
      }
      const taskMatch = url.pathname.match(/^\/tasks\/([^/]+)$/);
      if (taskMatch) {
        const task = await this.observationQueryService.getTask(decodeURIComponent(taskMatch[1]));
        if (!task) return this.writeJson(res, 404, { message: "task not found" });
        return this.writeJson(res, 200, task);
      }
      const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
      if (sessionMatch) {
        const session = await this.observationQueryService.getSession(decodeURIComponent(sessionMatch[1]));
        if (!session) return this.writeJson(res, 404, { message: "session not found" });
        return this.writeJson(res, 200, session);
      }
      const leaseMatch = url.pathname.match(/^\/leases\/([^/]+)$/);
      if (leaseMatch) {
        const lease = await this.observationQueryService.getLease(decodeURIComponent(leaseMatch[1]));
        if (!lease) return this.writeJson(res, 404, { message: "lease not found" });
        return this.writeJson(res, 200, lease);
      }
      if (url.pathname === "/artifacts") {
        const taskId = url.searchParams.get("taskId");
        if (!taskId) return this.writeJson(res, 400, { message: "taskId is required" });
        return this.writeJson(res, 200, await this.observationQueryService.listArtifacts(taskId));
      }
      if (url.pathname === "/events") {
        const taskId = url.searchParams.get("taskId") ?? undefined;
        const type = url.searchParams.get("type") ?? undefined;
        const limit = Number(url.searchParams.get("limit") ?? "0");
        return this.writeJson(
          res,
          200,
          await this.observationQueryService.listEvents({
            taskId,
            type,
            limit: Number.isFinite(limit) ? limit : 0,
          }),
        );
      }
      return this.writeJson(res, 404, { message: "not found" });
    });
    server.listen(this.port);
    return server;
  }

  private readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  private async handlePlatformCommand(
    req: IncomingMessage,
    res: import("node:http").ServerResponse<IncomingMessage>,
  ): Promise<void> {
    let raw = "";
    try {
      raw = await this.readRequestBody(req);
    } catch {
      return this.writeJson(res, 400, { message: "invalid body" });
    }
    let parsed: unknown;
    try {
      parsed = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return this.writeJson(res, 400, { message: "invalid json" });
    }
    const cmd =
      parsed && typeof parsed === "object" && "command" in (parsed as object)
        ? (parsed as { command?: PlatformToAgentCommand }).command
        : (parsed as PlatformToAgentCommand);
    if (!cmd || typeof cmd !== "object" || typeof (cmd as { type?: unknown }).type !== "string") {
      return this.writeJson(res, 400, { message: "missing command.type" });
    }
    const cmdType = (cmd as { type: string }).type;
    const needsLeaseSvc =
      cmdType === "AcquireLeaseCommand" ||
      cmdType === "ReleaseLeaseCommand" ||
      cmdType === "RenewLeaseCommand" ||
      cmdType === "RevokeLeaseByResourceCommand";
    const needsTaskSvc = cmdType === "CreateTaskCommand" || cmdType === "CancelTaskCommand";
    const needsAppPkgSvc = cmdType === "InstallAppCommand" || cmdType === "UninstallAppCommand";
    if (needsLeaseSvc && !this.leaseService) {
      return this.writeJson(res, 503, { message: "lease service unavailable" });
    }
    if (needsTaskSvc && !this.taskService) {
      return this.writeJson(res, 503, { message: "task service unavailable" });
    }
    if (needsAppPkgSvc && !this.appPackageService) {
      return this.writeJson(res, 503, { message: "app package service unavailable" });
    }
    try {
      switch (cmd.type) {
        case "AcquireLeaseCommand": {
          const c = cmd as Extract<PlatformToAgentCommand, { type: "AcquireLeaseCommand" }>;
          const ot = c.ownerType as OwnerType;
          if (!Object.values(OwnerType).includes(ot)) {
            return this.writeJson(res, 400, { message: "invalid ownerType" });
          }
          await this.leaseService!.acquire(c.leaseId, c.resourceId, c.ownerId, ot, c.ttlSeconds, {
            username: c.occupantUsername,
            displayName: c.occupantDisplayName,
          });
          return this.writeJson(res, 200, { ok: true });
        }
        case "ReleaseLeaseCommand": {
          const c = cmd as Extract<PlatformToAgentCommand, { type: "ReleaseLeaseCommand" }>;
          await this.leaseService!.release(asLeaseId(c.leaseId));
          return this.writeJson(res, 200, { ok: true });
        }
        case "RenewLeaseCommand": {
          const c = cmd as Extract<PlatformToAgentCommand, { type: "RenewLeaseCommand" }>;
          await this.leaseService!.renew(asLeaseId(c.leaseId), c.ttlSeconds);
          return this.writeJson(res, 200, { ok: true });
        }
        case "RevokeLeaseByResourceCommand": {
          const c = cmd as Extract<PlatformToAgentCommand, { type: "RevokeLeaseByResourceCommand" }>;
          if (this.occupationRelease) {
            await this.occupationRelease.forceRelease(c.resourceId);
          } else {
            await this.leaseService!.revokeByResourceId(c.resourceId);
          }
          return this.writeJson(res, 200, { ok: true });
        }
        case "CreateTaskCommand": {
          const c = cmd as Extract<PlatformToAgentCommand, { type: "CreateTaskCommand" }>;
          void this.taskService!.dispatch(c).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[HttpServer] CreateTaskCommand dispatch failed: ${message}`);
          });
          return this.writeJson(res, 202, { ok: true, accepted: true });
        }
        case "CancelTaskCommand": {
          const c = cmd as Extract<PlatformToAgentCommand, { type: "CancelTaskCommand" }>;
          await this.taskService!.cancel(asTaskId(c.taskId));
          return this.writeJson(res, 200, { ok: true });
        }
        case "InstallAppCommand": {
          const c = cmd as Extract<PlatformToAgentCommand, { type: "InstallAppCommand" }>;
          await this.appPackageService!.install(c.resourceId, c.appRef);
          return this.writeJson(res, 200, { ok: true });
        }
        case "UninstallAppCommand": {
          const c = cmd as Extract<PlatformToAgentCommand, { type: "UninstallAppCommand" }>;
          await this.appPackageService!.uninstall(c.resourceId, c.bundleId);
          return this.writeJson(res, 200, { ok: true });
        }
        default:
          return this.writeJson(res, 400, { message: `unsupported command: ${(cmd as { type: string }).type}` });
      }
    } catch (error: unknown) {
      if (error instanceof LeaseConflictError) {
        return this.writeJson(res, 409, { ok: false, message: error.message, resourceId: error.resourceId });
      }
      const message = error instanceof Error ? error.message : String(error);
      return this.writeJson(res, 500, { ok: false, message });
    }
  }

  private writeJson(
    res: import("node:http").ServerResponse<import("node:http").IncomingMessage>,
    statusCode: number,
    data: unknown,
  ): void {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(data));
  }
}
