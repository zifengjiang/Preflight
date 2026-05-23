import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  isCallbackNotFoundError,
  type PlatformCallbackClient,
  type TaskLogCallbackPayload,
  type TaskReportCallbackPayload,
} from "./PlatformCallbackClient.js";

const OUTBOX_NAME = "callback-outbox";

export type OutboxEnqueued = { id: string };

type OutboxRecord =
  | { v: 1; kind: "log"; taskId: string; payload: TaskLogCallbackPayload }
  | { v: 1; kind: "report"; taskId: string; payload: TaskReportCallbackPayload }
  | { v: 1; kind: "status"; taskId: string; payload: { agentId: string; status: string; message?: string } };

/** 出站队列某条记录连续失败后，下次最早尝试时间（指数退避，避免平台短时不可用仍高频 POST） */
function outboxBackoffBaseMs(): number {
  const raw = Number(process.env.CALLBACK_OUTBOX_BACKOFF_BASE_MS ?? "2000");
  return Number.isFinite(raw) && raw >= 200 ? Math.floor(raw) : 2000;
}

function outboxBackoffMaxMs(): number {
  const raw = Number(process.env.CALLBACK_OUTBOX_BACKOFF_MAX_MS ?? "300000");
  return Number.isFinite(raw) && raw >= 1000 ? Math.floor(raw) : 300000;
}

function defaultOutboxDir(): string {
  return path.join(
    process.env.CALLBACK_OUTBOX_DIR?.trim() || path.join(homedir(), ".preflight-agent"),
    OUTBOX_NAME,
  );
}

export class CallbackOutboxStore {
  private readonly nextEligibleAt = new Map<string, number>();
  private readonly consecutiveFails = new Map<string, number>();

  constructor(private readonly dir = defaultOutboxDir()) {}

  private async pathFor(id: string): Promise<string> {
    return path.join(this.dir, id);
  }

  async ensureReady(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async enqueue(record: Omit<OutboxRecord, "v"> & { v?: 1 }): Promise<OutboxEnqueued> {
    const id = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`;
    const full: OutboxRecord = { v: 1, ...record } as OutboxRecord;
    await this.ensureReady();
    const filePath = await this.pathFor(id);
    await writeFile(filePath, JSON.stringify(full), "utf8");
    return { id };
  }

  async processWith(client: PlatformCallbackClient, limit = 50): Promise<{ processed: number; failed: number }> {
    let processed = 0;
    let failed = 0;
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return { processed, failed };
    }
    const sorted = files.filter((f) => f.endsWith(".json")).sort();
    for (const name of sorted) {
      if (processed + failed >= limit) break;
      const fp = path.join(this.dir, name);
      const eligibleAt = this.nextEligibleAt.get(fp) ?? 0;
      if (Date.now() < eligibleAt) continue;

      let raw: string;
      try {
        raw = await readFile(fp, "utf8");
      } catch {
        continue;
      }
      let rec: OutboxRecord;
      try {
        rec = JSON.parse(raw) as OutboxRecord;
      } catch {
        continue;
      }
      try {
        if (rec.kind === "log") {
          await client.pushTaskLog(rec.taskId, rec.payload);
        } else if (rec.kind === "report") {
          await client.pushTaskReport(rec.taskId, rec.payload);
        } else {
          await client.pushTaskStatus(rec.taskId, rec.payload);
        }
        await rm(fp, { force: true });
        this.nextEligibleAt.delete(fp);
        this.consecutiveFails.delete(fp);
        processed += 1;
      } catch (e) {
        if (isCallbackNotFoundError(e)) {
          await rm(fp, { force: true });
          this.nextEligibleAt.delete(fp);
          this.consecutiveFails.delete(fp);
          processed += 1;
          console.warn(
            `[CallbackOutbox] dropped ${name} taskId=${rec.taskId} (callback 404, removed from outbox)`,
          );
          continue;
        }
        failed += 1;
        const n = (this.consecutiveFails.get(fp) ?? 0) + 1;
        this.consecutiveFails.set(fp, n);
        const rawDelay = outboxBackoffBaseMs() * 2 ** Math.min(n - 1, 14);
        const delay = Math.min(outboxBackoffMaxMs(), rawDelay);
        this.nextEligibleAt.set(fp, Date.now() + delay);
        console.warn(
          `[CallbackOutbox] redelivery failed ${name} taskId=${rec.taskId} fail#=${n} nextEligibleIn=${delay}ms`,
        );
      }
    }
    return { processed, failed };
  }
}

