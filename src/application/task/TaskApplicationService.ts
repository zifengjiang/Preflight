import type { ArtifactApplicationService } from "../artifact/ArtifactApplicationService.js";
import type { LeaseApplicationService } from "../lease/LeaseApplicationService.js";
import type { ReporterApplicationService } from "../reporter/ReporterApplicationService.js";
import type { SessionApplicationService } from "../session/SessionApplicationService.js";
import type { MidsceneReportProgressPayload, MidsceneRuntime } from "../../domain/runtime/interfaces.js";
import type { CreateTaskCommand } from "../../protocol-contracts/commands/index.js";
import { readFile, rm } from "node:fs/promises";
import { TaskRecord } from "../../domain/task/TaskRecord.js";
import { TaskSpec } from "../../domain/task/TaskSpec.js";
import type { ResourceRepository, TaskRepository } from "../../domain/repositories/index.js";
import { EventType, OwnerType, ResourceStatus, TaskStatus } from "../../shared-kernel/enums/index.js";
import { asResourceId, asTaskId, type TaskId } from "../../shared-kernel/ids/index.js";
import type { PlatformCallbackClient } from "../../infrastructure/transport/http/PlatformCallbackClient.js";
import { LeaseRequiredError } from "../../shared-kernel/errors/index.js";
import { buildMidsceneReportStemForTask } from "../../utils/midsceneReportConstants.js";
import path from "node:path";
import { readMidsceneTaskCacheFileIfExists, seedMidsceneTaskCacheFromRuntimeEnv } from "../../utils/seedMidsceneTaskCache.js";

type TaskCallbackClient = Pick<PlatformCallbackClient, "pushTaskStatus" | "pushTaskLog" | "pushTaskReport">;
const TASK_AUTO_LEASE_TTL_SECONDS = 120;

function normalizeRuntimeEnv(raw?: Record<string, string>): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith("MIDSCENE_")) continue;
    const v = String(value ?? "").trim();
    if (!v) continue;
    out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export class TaskApplicationService {
  private runningAbortControllers = new Map<string, AbortController>();
  private resourceExecutionChains = new Map<string, Promise<void>>();

  private toTaskFailureMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async ensureTaskLease(resourceId: string, taskId: TaskId) {
    try {
      return await this.leaseService.ensureActive(asResourceId(resourceId));
    } catch (error) {
      if (!(error instanceof LeaseRequiredError)) throw error;
      const leaseId = `lease-task-${String(taskId)}-${Date.now()}`;
      console.info(
        `[TaskApplicationService] auto acquiring lease taskId=${String(taskId)} resourceId=${resourceId} leaseId=${leaseId}`,
      );
      return this.leaseService.acquire(
        leaseId,
        resourceId,
        String(taskId),
        OwnerType.PLATFORM_TASK,
        TASK_AUTO_LEASE_TTL_SECONDS,
      );
    }
  }

  private isResourceBusy(resourceId: string): boolean {
    return this.resourceExecutionChains.has(resourceId);
  }

  private async enqueueOnResource(resourceId: string, run: () => Promise<void>): Promise<void> {
    const previous = this.resourceExecutionChains.get(resourceId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(run)
      .finally(() => {
        if (this.resourceExecutionChains.get(resourceId) === next) {
          this.resourceExecutionChains.delete(resourceId);
        }
      });
    this.resourceExecutionChains.set(resourceId, next);
    return next;
  }

  constructor(
    private readonly taskRepository: TaskRepository,
    private readonly resourceRepository: ResourceRepository,
    private readonly leaseService: LeaseApplicationService,
    private readonly sessionService: SessionApplicationService,
    private readonly artifactService: ArtifactApplicationService,
    private readonly reporter: ReporterApplicationService,
    private readonly midsceneRuntime: MidsceneRuntime,
    private readonly callbackClient: TaskCallbackClient,
    private readonly selfAgentId: string,
    /** 任务子进程内 `installApp`/`uninstallApp` 调本机 Agent HTTP 的根地址（无尾斜杠） */
    private readonly taskAgentHttpBaseUrl: string,
    /** 可选；未设则子进程沿用父进程 `AGENT_HTTP_TOKEN` */
    private readonly taskAgentHttpToken?: string,
  ) {}

  private buildChildMidsceneEnv(params: CreateTaskCommand, spec: TaskSpec, taskId: TaskId): Record<string, string> {
    const base = normalizeRuntimeEnv(params.runtimeEnv) ?? {};
    const out: Record<string, string> = { ...base };
    out.MIDSCENE_FLOW_TASK_ID = String(taskId);
    out.MIDSCENE_FLOW_REPORT_STEM = buildMidsceneReportStemForTask(spec.requiredPlatform, String(taskId));
    // 将父进程的 MIDSCENE_* 中未显式传入的自动继承到子进程
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("MIDSCENE_") && !(key in out) && process.env[key]?.trim()) {
        out[key] = process.env[key]!.trim();
      }
    }
    if (!out.MIDSCENE_OUTPUT_FORMAT?.trim()) {
      out.MIDSCENE_OUTPUT_FORMAT = "single-html";
    }
    return out;
  }

  async dispatch(params: CreateTaskCommand): Promise<void> {
    const midsceneKeyCount = Object.keys(normalizeRuntimeEnv(params.runtimeEnv) ?? {}).length;
    console.info(
      `[TaskApplicationService] dispatch taskId=${params.taskId} requiredPlatform=${params.requiredPlatform} resourceId=${params.resourceId ?? ""} selector=${JSON.stringify(params.selector ?? null)} scriptLength=${params.script?.length ?? 0} runtimeEnvKeys=${midsceneKeyCount}`,
    );
    const taskId = asTaskId(params.taskId);
    const existing = await this.taskRepository.getById(taskId);
    if (existing) {
      console.warn(
        `[TaskApplicationService] skip duplicate dispatch taskId=${params.taskId} existingStatus=${existing.status}`,
      );
      return;
    }
    const scriptKind = params.scriptKind ?? "midscene";
    const spec = new TaskSpec(params.requiredPlatform, params.script, scriptKind, scriptKind === "airtest" ? {
      bundleBase64: params.airtestBundleBase64 ?? "",
      entryDir: params.airtestEntryDir ?? "",
      archiveName: params.airtestArchiveName,
      caseRunId: params.caseRunId,
      caseIndex: params.caseIndex,
      caseName: params.caseName,
    } : undefined);
    const task = new TaskRecord(taskId, spec, TaskStatus.CREATED);
    await this.taskRepository.save(task);
    await this.reporter.emit(EventType.TASK_UPDATED, { taskId, status: TaskStatus.CREATED });
    await this.callbackClient.pushTaskStatus(String(taskId), {
      agentId: this.selfAgentId,
      status: TaskStatus.CREATED,
    }).catch(() => {});

    const resources = await this.resourceRepository.list();
    const onlineByPlatform = resources.filter(
      (item) => item.platform === params.requiredPlatform && item.status === ResourceStatus.ONLINE,
    );
    const requested = params.resourceId?.trim();
    let candidate =
      requested != null && requested.length > 0
        ? onlineByPlatform.find((item) => item.id === requested)
        : undefined;
    if (!candidate) {
      const wantedLabels = (params.selector?.labels ?? []).map((item) => item.trim()).filter(Boolean);
      const matched = onlineByPlatform.filter((item) => {
        if (!wantedLabels.length) return true;
        const labels = item.capability.labels ?? [];
        return wantedLabels.every((label) => labels.includes(label));
      });
      candidate = matched.find((item) => !this.isResourceBusy(item.id)) ?? matched[0];
    }
    if (!candidate) {
      console.warn(
        `[TaskApplicationService] no candidate taskId=${params.taskId} requestedResourceId=${requested ?? ""} platform=${params.requiredPlatform}`,
      );
      task.status = TaskStatus.FAILED;
      task.message = requested ? `resource not available: ${requested}` : "no online resource matched";
      await this.taskRepository.save(task);
      await this.reporter.emit(EventType.TASK_UPDATED, { taskId, status: task.status, message: task.message });
      return;
    }

    const mergedMidsceneEnv = this.buildChildMidsceneEnv(params, spec, taskId);
    mergedMidsceneEnv.AGENT_RESOURCE_ID = candidate.id;
    mergedMidsceneEnv.AGENT_HTTP_BASE_URL = this.taskAgentHttpBaseUrl;
    const qTok = this.taskAgentHttpToken?.trim();
    if (qTok) mergedMidsceneEnv.AGENT_HTTP_TOKEN = qTok;

    await this.enqueueOnResource(candidate.id, async () => {
      try {
        const lease = await this.ensureTaskLease(candidate.id, taskId);
        const session = await this.sessionService.createExecution(
          `exec-${taskId}`,
          candidate.id,
          lease.id,
          String(taskId),
          OwnerType.PLATFORM_TASK,
        );
        task.status = TaskStatus.RUNNING;
        task.sessionId = session.id;
        await this.taskRepository.save(task);
        await this.reporter.emit(EventType.TASK_UPDATED, { taskId, status: task.status });
        await this.callbackClient.pushTaskStatus(String(taskId), {
          agentId: this.selfAgentId,
          status: task.status,
        }).catch(() => {});

        const abortController = new AbortController();
        this.runningAbortControllers.set(String(taskId), abortController);
        if (this.midsceneRuntime.prepare) {
          await this.midsceneRuntime.prepare(spec, candidate.id, abortController.signal);
        }
        seedMidsceneTaskCacheFromRuntimeEnv(mergedMidsceneEnv);
        let logBuffer = "";
        let logTimer: ReturnType<typeof setTimeout> | null = null;
        let anyLogStreamed = false;
        let logSeq = 0;
        const LOG_FLUSH_MS = 150;

        const flushLogBuffer = (): void => {
          if (logTimer) {
            clearTimeout(logTimer);
            logTimer = null;
          }
          const chunk = logBuffer;
          logBuffer = "";
          if (!chunk) return;
          anyLogStreamed = true;
          logSeq += 1;
          void this.callbackClient
            .pushTaskLog(String(taskId), {
              agentId: this.selfAgentId,
              chunk,
              seq: logSeq,
              isFinal: false,
              stream: "mixed",
            })
            .catch((err) => {
              console.warn(
                `[TaskApplicationService] pushTaskLog failed taskId=${params.taskId} error=${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            });
        };

        const onReportProgress = (p: MidsceneReportProgressPayload) => {
          void (async () => {
            let reportBundleBase64: string | undefined;
            let zipPath: string | undefined;
            if (p.reportBundleZipUri?.startsWith("file://")) {
              zipPath = decodeURIComponent(p.reportBundleZipUri.slice("file://".length));
              try {
                const buf = await readFile(zipPath);
                reportBundleBase64 = buf.toString("base64");
              } catch (err) {
                console.warn(
                  `[TaskApplicationService] read report zip failed taskId=${params.taskId} error=${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
              }
            }
            try {
              await this.callbackClient.pushTaskReport(String(taskId), {
                agentId: this.selfAgentId,
                reportHtml: p.reportHtml ?? "",
                reportName: p.reportName,
                reportFormat: p.reportFormat,
                partial: p.partial,
                reportBundleBase64: reportBundleBase64,
                ...(p.executionDumpJson !== undefined ? { executionDumpJson: p.executionDumpJson } : {}),
                ...(p.executionDumpRevision !== undefined ? { executionDumpRevision: p.executionDumpRevision } : {}),
                ...(p.reportAssetFiles !== undefined ? { reportAssetFiles: p.reportAssetFiles } : {}),
              });
              if (zipPath) {
                const zipParent = path.dirname(zipPath);
                try {
                  await rm(zipPath, { force: true });
                  if (path.basename(zipParent).startsWith("report-zip-")) {
                    await rm(zipParent, { recursive: true, force: true });
                  }
                } catch {
                  /* ignore */
                }
              }
            } catch (err) {
              console.warn(
                `[TaskApplicationService] pushTaskReport failed taskId=${params.taskId} error=${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          })();
        };

        const result = await this.midsceneRuntime.execute(spec, candidate.id, abortController.signal, {
          runtimeEnv: mergedMidsceneEnv,
          taskId: String(taskId),
          onLogChunk: (text, stream) => {
            logBuffer += stream === "stderr" ? `[stderr] ${text}` : text;
            if (logTimer) return;
            logTimer = setTimeout(() => {
              logTimer = null;
              flushLogBuffer();
            }, LOG_FLUSH_MS);
          },
          onReportProgress,
        });
        flushLogBuffer();
        if (anyLogStreamed) {
          logSeq += 1;
          void this.callbackClient
            .pushTaskLog(String(taskId), {
              agentId: this.selfAgentId,
              chunk: "",
              seq: logSeq,
              isFinal: true,
              stream: "mixed",
            })
            .catch((err) => {
              console.warn(
                `[TaskApplicationService] pushTaskLog (final) failed taskId=${params.taskId} error=${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            });
        }

        try {
          const cacheAsset = await readMidsceneTaskCacheFileIfExists(mergedMidsceneEnv);
          if (cacheAsset) {
            await this.callbackClient.pushTaskReport(String(taskId), {
              agentId: this.selfAgentId,
              reportHtml: "",
              partial: true,
              executionDumpRevision: 0,
              reportAssetFiles: [cacheAsset],
            });
          }
        } catch (err) {
          console.warn(
            `[TaskApplicationService] pushTaskReport(cache yaml) failed taskId=${params.taskId} error=${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        console.info(
          `[TaskApplicationService] execute finished taskId=${params.taskId} resourceId=${candidate.id} ok=${result.ok} message=${result.message}`,
        );
        const refs = await this.artifactService.saveTaskArtifacts(
          taskId,
          result.artifacts.map((item) => ({ type: item.type, uri: item.uri })),
        );
        for (const ref of refs) {
          await this.reporter.emit(EventType.ARTIFACT_READY, {
            taskId,
            artifactId: ref.id,
            artifactType: ref.type,
            uri: ref.uri,
          });
        }
        const logArtifact = refs.find((item) => item.type === "LOG");
        if (logArtifact?.uri?.startsWith("file://") && !anyLogStreamed) {
          try {
            const logPath = decodeURIComponent(logArtifact.uri.slice("file://".length));
            const logText = await readFile(logPath, "utf8");
            await this.callbackClient.pushTaskLog(String(taskId), {
              agentId: this.selfAgentId,
              chunk: logText,
              seq: 1,
              isFinal: true,
              stream: "mixed",
            });
          } catch (error) {
            console.warn(
              `[TaskApplicationService] callback log (file) failed taskId=${params.taskId} error=${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }

        if (result.reportInfo?.reportBundleZipPath) {
          const zp = result.reportInfo.reportBundleZipPath;
          try {
            await rm(zp, { force: true });
            const parent = path.dirname(zp);
            if (path.basename(parent).startsWith("report-zip-")) {
              await rm(parent, { recursive: true, force: true });
            }
          } catch {
            /* ignore */
          }
        }

        task.status = result.ok ? TaskStatus.SUCCESS : TaskStatus.FAILED;
        task.message = result.message;
        await this.taskRepository.save(task);
        await this.sessionService.closeExecution(session.id);
        await this.reporter.emit(EventType.TASK_UPDATED, { taskId, status: task.status, message: task.message });
        await this.callbackClient.pushTaskStatus(String(taskId), {
          agentId: this.selfAgentId,
          status: task.status,
          ...(task.message ? { message: task.message } : {}),
        }).catch(() => {});
      } catch (error) {
        const failureMessage = this.toTaskFailureMessage(error);
        console.error(
          `[TaskApplicationService] execute failed taskId=${params.taskId} error=${failureMessage}`,
        );
        task.status = TaskStatus.FAILED;
        task.message = failureMessage;
        await this.taskRepository.save(task);
        await this.reporter.emit(EventType.TASK_UPDATED, { taskId, status: task.status, message: task.message });
        await this.callbackClient.pushTaskStatus(String(taskId), {
          agentId: this.selfAgentId,
          status: task.status,
          ...(task.message ? { message: task.message } : {}),
        }).catch(() => {});
      } finally {
        this.runningAbortControllers.delete(String(taskId));
      }
    });
  }

  async cancel(taskId: TaskId): Promise<void> {
    const task = await this.taskRepository.getById(taskId);
    if (!task) return;
    const abort = this.runningAbortControllers.get(String(taskId));
    if (abort) abort.abort("cancelled by platform");
    task.status = TaskStatus.CANCELLED;
    task.message = "cancelled by platform";
    await this.taskRepository.save(task);
    await this.reporter.emit(EventType.TASK_UPDATED, { taskId, status: task.status, message: task.message });
    await this.callbackClient.pushTaskStatus(String(taskId), {
      agentId: this.selfAgentId,
      status: task.status,
      message: task.message,
    }).catch(() => {});
  }
}
