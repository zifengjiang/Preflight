import { createServer, type Server } from "node:http";
import { createReadStream } from "node:fs";
import type { RunManager } from "./runManager.js";
import { resolveSafeAssetPath } from "./live/assetPath.js";
import { buildTimelineFromReportDir, mergeWithVisualFlow, resolveActiveReportDir } from "./live/dumpTimeline.js";
import { extractFlowStepEventsFromRun } from "./flowStepEvents.js";
import { probeForegroundBundleId } from "./live/foregroundProbe.js";
import { resolveStreamPlan } from "./live/streamSource.js";
import { proxyMjpeg, spawnFfmpegMjpeg, spawnScrcpyMjpeg, writeMjpegHeaders } from "./live/deviceStream.js";
import { renderLivePage } from "./live/page.js";

export interface LiveViewerServer {
  server: Server;
  port: number;
  baseUrl: string;
}

export async function startLiveViewer(port: number, runManager: RunManager): Promise<LiveViewerServer> {
  let lastError: unknown;
  for (let candidate = port; candidate < port + 20; candidate += 1) {
    try {
      const server = createLiveViewerServer(runManager);
      await listen(server, candidate);
      return { server, port: candidate, baseUrl: `http://127.0.0.1:${candidate}` };
    } catch (error) {
      lastError = error;
      if (!isAddressInUse(error)) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function createLiveViewerServer(runManager: RunManager): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const runMatch = url.pathname.match(/^\/runs\/([^/]+)\/live$/);
      if (runMatch) {
        const run = runManager.getRun(decodeURIComponent(runMatch[1]));
        if (!run) {
          res.statusCode = 404;
          res.end("run not found");
          return;
        }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(renderLivePage(run.runId));
        return;
      }
      const apiMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (apiMatch) {
        const run = runManager.getRun(decodeURIComponent(apiMatch[1]));
        if (!run) {
          res.statusCode = 404;
          res.end(JSON.stringify({ message: "run not found" }));
          return;
        }
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify(run));
        return;
      }
      const eventsMatch = url.pathname.match(/^\/runs\/([^/]+)\/events$/);
      if (eventsMatch) {
        const run = runManager.getRun(decodeURIComponent(eventsMatch[1]));
        if (!run) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        let alive = true;
        res.on("close", () => {
          alive = false;
        });
        const tick = async () => {
          if (!alive) return;
          const r = runManager.getRun(run.runId);
          const fg = r?.streamParams ? await probeForegroundBundleId(r.streamParams) : undefined;
          let revision = 0;
          if (r?.reportDir) {
            try {
              revision = (await buildTimelineFromReportDir(await resolveActiveReportDir(r.reportDir, Date.parse(r.createdAt)))).revision;
            } catch {
              revision = 0;
            }
          }
          if (!alive) return;
          res.write(`data: ${JSON.stringify({ status: r?.task?.status ?? "CREATED", bundleId: fg, revision, updatedAt: r?.updatedAt })}\n\n`);
          if (alive) setTimeout(tick, 1500);
        };
        void tick();
        return;
      }
      const dumpMatch = url.pathname.match(/^\/runs\/([^/]+)\/dump$/);
      if (dumpMatch) {
        const run = runManager.getRun(decodeURIComponent(dumpMatch[1]));
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        if (!run?.reportDir) {
          res.statusCode = 404;
          res.end(JSON.stringify({ revision: 0, steps: [] }));
          return;
        }
        try {
          const activeDir = await resolveActiveReportDir(run.reportDir, Date.parse(run.createdAt));
          const view = mergeWithVisualFlow(await buildTimelineFromReportDir(activeDir), run.visualFlow, extractFlowStepEventsFromRun(run));
          res.end(JSON.stringify(view));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ revision: 0, steps: [] }));
        }
        return;
      }
      const assetMatch = url.pathname.match(/^\/runs\/([^/]+)\/report\/(.+)$/);
      if (assetMatch) {
        const run = runManager.getRun(decodeURIComponent(assetMatch[1]));
        if (!run?.reportDir) {
          res.statusCode = 404;
          res.end();
          return;
        }
        const activeDir = await resolveActiveReportDir(run.reportDir, Date.parse(run.createdAt));
        const safe = resolveSafeAssetPath(activeDir, decodeURIComponent(assetMatch[2]));
        if (!safe) {
          res.statusCode = 403;
          res.end();
          return;
        }
        createReadStream(safe)
          .on("error", () => {
            if (!res.headersSent) res.statusCode = 404;
            res.end();
          })
          .pipe(res);
        return;
      }
      const screenMatch = url.pathname.match(/^\/runs\/([^/]+)\/screen\.mjpeg$/);
      if (screenMatch) {
        const run = runManager.getRun(decodeURIComponent(screenMatch[1]));
        if (!run?.streamParams) {
          res.statusCode = 404;
          res.end();
          return;
        }
        const plan = resolveStreamPlan(run.streamParams);
        if (plan.kind === "mjpeg-proxy") {
          proxyMjpeg(res, plan.url);
          return;
        }
        writeMjpegHeaders(res);
        if (plan.kind === "scrcpy-ffmpeg") {
          await spawnScrcpyMjpeg(res, plan);
          return;
        }
        await spawnFfmpegMjpeg(res, plan.producer);
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    } catch {
      if (!res.headersSent) {
        res.statusCode = 500;
      }
      res.end();
    }
  });
  return server;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "EADDRINUSE";
}
