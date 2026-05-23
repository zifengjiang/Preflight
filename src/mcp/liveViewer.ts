import { createServer, type Server } from "node:http";
import type { RunManager } from "./runManager.js";

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
  const server = createServer((req, res) => {
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
    res.statusCode = 404;
    res.end("not found");
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

function renderLivePage(runId: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Qingju Self Test ${escapeHtml(runId)}</title>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f8fa; color: #15171a; }
    header { padding: 16px 20px; background: #101214; color: white; }
    main { display: grid; grid-template-columns: minmax(280px, 420px) 1fr; gap: 16px; padding: 16px; }
    section { background: white; border: 1px solid #dfe3e8; border-radius: 8px; padding: 14px; min-width: 0; }
    h1 { font-size: 16px; margin: 0 0 4px; }
    h2 { font-size: 14px; margin: 0 0 10px; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #f1f3f5; padding: 10px; border-radius: 6px; max-height: 68vh; overflow: auto; }
    .status { font-weight: 700; }
    .artifact { display: block; margin: 6px 0; overflow-wrap: anywhere; }
    .steps { display: grid; gap: 6px; }
    .step { border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px 10px; background: #fafafa; }
    .step.running { border-color: #2f80ed; background: #eef6ff; }
    .step.passed { border-color: #2f9e44; background: #effaf2; }
    .step.failed { border-color: #d64545; background: #fff1f1; }
    .step-title { font-size: 13px; font-weight: 650; overflow-wrap: anywhere; }
    .step-meta { margin-top: 4px; color: #626b76; font-size: 12px; overflow-wrap: anywhere; }
    @media (max-width: 820px) { main { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>Qingju Live Viewer</h1>
    <div>Run ID: ${escapeHtml(runId)}</div>
  </header>
  <main>
    <section>
      <h2>状态</h2>
      <div id="status" class="status">loading</div>
      <p id="meta"></p>
      <h2>产物</h2>
      <div id="artifacts"></div>
    </section>
    <section>
      <h2>Visual Flow 步骤</h2>
      <div id="steps" class="steps"></div>
      <h2>事件与任务快照</h2>
      <pre id="raw"></pre>
    </section>
  </main>
  <script>
    const runId = ${JSON.stringify(runId)};
    async function refresh() {
      const resp = await fetch('/api/runs/' + encodeURIComponent(runId));
      const run = await resp.json();
      document.getElementById('status').textContent = run.task?.status || 'CREATED';
      document.getElementById('meta').textContent = [run.platform, run.resourceId, run.taskId].filter(Boolean).join(' | ');
      document.getElementById('artifacts').innerHTML = (run.artifacts || []).map(a => {
        const text = a.type + ': ' + a.uri;
        return '<a class="artifact" href="' + escapeAttr(a.uri) + '" target="_blank" rel="noreferrer">' + escapeText(text) + '</a>';
      }).join('') || '暂无产物';
      renderSteps(run.flowStepView);
      document.getElementById('raw').textContent = JSON.stringify(run, null, 2);
    }
    function renderSteps(view) {
      const steps = Array.isArray(view?.steps) ? view.steps : [];
      document.getElementById('steps').innerHTML = steps.map(s => {
        const depth = Number.isFinite(Number(s.depth)) ? Number(s.depth) : 0;
        const meta = [
          '#' + s.index,
          s.type,
          s.status,
          s.durationMs != null ? s.durationMs + 'ms' : '',
          s.message || ''
        ].filter(Boolean).join(' | ');
        return '<div class="step ' + escapeAttr(s.status || 'pending') + '" style="margin-left:' + Math.min(depth * 14, 56) + 'px">' +
          '<div class="step-title">' + escapeText(s.title || s.type || 'step') + '</div>' +
          '<div class="step-meta">' + escapeText(meta) + '</div>' +
        '</div>';
      }).join('') || '<div class="step"><div class="step-title">暂无 visualFlow 步骤</div></div>';
    }
    function escapeText(s) { return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
    function escapeAttr(s) { return escapeText(s).replace(/"/g, '&quot;'); }
    refresh();
    setInterval(refresh, 1500);
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[char] ?? char));
}
