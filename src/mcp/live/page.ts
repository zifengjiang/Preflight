/**
 * Device-centric live viewer page (vanilla, dependency-free).
 *
 * Returns a complete HTML document with inline CSS + vanilla JS. The page talks
 * to endpoints served by the live HTTP server:
 *   GET /api/runs/{runId}            -> full RunState JSON (once on load, refreshed on revision)
 *   GET /runs/{runId}/events         -> SSE stream of { status, bundleId, revision, updatedAt }
 *   GET /runs/{runId}/dump           -> TimelineView { revision, steps[] }
 *   GET /runs/{runId}/screen.mjpeg   -> live MJPEG (img src)
 *   GET /runs/{runId}/report/<rel>   -> screenshot asset bytes
 *
 * Design language: locked dark dev-tool monitor, single accent, semantic-only
 * status color, monospace for all numerics. Motion is wrapped in
 * prefers-reduced-motion: no-preference. Loading / empty / reconnect states are
 * intentionally out of scope here (Task 9) but the structure leaves room for them.
 */
import { stepCollapsedHTML, stepExpandedHTML, dataHTML, GLYPH } from "./timelineMarkup.js";

export function renderLivePage(runId: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Preflight Live ${escapeHtml(runId)}</title>
  <style>
    :root {
      --bg: #0f1115;
      --surface: #15181e;
      --border: #23262d;
      --accent: #3b82f6;
      --green: #46d17f;
      --red: #e5484d;
      --text: #e6e9ef;
      --muted: #8b929e;
      --radius: 8px;
      --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
      --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      height: 100dvh;
      display: flex;
      flex-direction: column;
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      font-size: 13px;
      line-height: 1.45;
      overflow: hidden;
    }
    .mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }

    /* ── Status bar ──────────────────────────────────────────────── */
    #statusbar {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 14px;
      height: 44px;
      padding: 0 14px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
      overflow: hidden;
    }
    .wordmark { font-weight: 700; letter-spacing: 0.3px; font-size: 13px; }
    .badge {
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.4px;
      text-transform: uppercase;
      padding: 3px 8px;
      border-radius: 5px;
      border: 1px solid var(--border);
      color: var(--muted);
    }
    .badge.is-running { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
    .badge.is-success { color: var(--green); border-color: color-mix(in srgb, var(--green) 45%, var(--border)); }
    .badge.is-failed { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, var(--border)); }
    .sep { color: var(--border); }
    #device-label { color: var(--muted); font-size: 12px; }
    .chip {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--text);
      background: var(--bg);
      border: 1px solid var(--border);
      padding: 2px 7px;
      border-radius: 5px;
      max-width: 220px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .metric { display: inline-flex; align-items: baseline; gap: 5px; color: var(--muted); font-size: 11px; }
    .metric .v { font-family: var(--mono); font-variant-numeric: tabular-nums; color: var(--text); font-size: 12px; }
    #test-intent {
      margin-left: auto;
      color: var(--muted);
      font-size: 12px;
      max-width: 38%;
      overflow: hidden;
      text-overflow: ellipsis;
      text-align: right;
    }

    /* ── Main split: device | timeline ──────────────────────────── */
    #main { flex: 1 1 auto; display: flex; min-height: 0; }

    #device {
      position: relative;
      background: #000;
      height: 100%;
      flex: 0 0 auto;
    }
    #screen { height: 100%; width: auto; display: block; object-fit: contain; }
    #live-badge {
      position: absolute;
      top: 10px;
      left: 10px;
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.6px;
      padding: 3px 8px;
      border-radius: 5px;
      background: rgba(15, 17, 21, 0.72);
      color: var(--accent);
      backdrop-filter: blur(2px);
      pointer-events: none;
    }
    #live-badge.snapshot { color: var(--muted); }

    /* ── Timeline ───────────────────────────────────────────────── */
    #timeline {
      flex: 1 1 0;
      min-width: 0;
      overflow-y: auto;
      padding: 10px 12px 14px;
      border-left: 1px solid var(--border);
    }
    .step {
      display: flex;
      align-items: baseline;
      gap: 10px;
      padding: 7px 10px;
      border: 1px solid transparent;
      border-radius: var(--radius);
      cursor: pointer;
    }
    .step:hover { background: var(--surface); }
    .step .g {
      flex: 0 0 auto;
      font-family: var(--mono);
      font-size: 13px;
      width: 14px;
      text-align: center;
      color: var(--muted);
    }
    .step .g.finished { color: var(--green); }
    .step .g.failed { color: var(--red); }
    .step .g.running { color: var(--accent); }
    .step .g.pending { color: var(--muted); }
    .step .t { flex: 1 1 auto; min-width: 0; overflow: hidden; }
    .step .t b { font-weight: 600; }
    .step .t .sub {
      color: var(--muted);
      font-weight: 400;
    }
    .step.pending .t b { color: var(--muted); font-weight: 400; }
    .step .dur {
      flex: 0 0 auto;
      font-family: var(--mono);
      font-variant-numeric: tabular-nums;
      font-size: 11px;
      color: var(--muted);
    }

    /* expanded card */
    .step.expanded {
      display: block;
      cursor: default;
      background: var(--surface);
      border-color: var(--border);
      padding: 12px;
      margin: 6px 0;
    }
    .step.expanded.running { border-color: var(--accent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent); }
    .step.expanded.failed { border-color: color-mix(in srgb, var(--red) 55%, var(--border)); }
    .step.expanded .head { font-weight: 600; margin-bottom: 10px; }
    .step.expanded .head b { font-weight: 600; }
    .cols { display: flex; gap: 14px; align-items: flex-start; }
    .cols .text { flex: 1 1 0; min-width: 0; display: grid; gap: 7px; }
    .cols .text > div { overflow-wrap: anywhere; }
    .lbl {
      display: inline-block;
      font-size: 11px;
      color: var(--muted);
      font-weight: 600;
      margin-right: 4px;
    }
    .cols .text .err { color: var(--red); }
    .cols .text .err .lbl { color: var(--red); }
    .data {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--muted);
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 8px;
      max-height: 120px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .strip {
      display: flex;
      flex-wrap: nowrap;
      gap: 8px;
      overflow-x: auto;
      flex: 0 1 auto;
      max-width: 55%;
      padding-bottom: 4px;
    }
    .strip figure { flex: 0 0 auto; margin: 0; text-align: center; }
    .strip figure.broken { display: none; }
    .strip img {
      height: 160px;
      width: auto;
      border-radius: 6px;
      border: 1px solid var(--border);
      display: block;
    }
    .strip figcaption {
      font-family: var(--mono);
      font-size: 10px;
      color: var(--muted);
      margin-top: 4px;
    }
    .strip .sub { color: var(--muted); font-size: 12px; align-self: center; }

    /* ── Bottom strip ───────────────────────────────────────────── */
    #bottom {
      flex: 0 0 auto;
      display: flex;
      align-items: stretch;
      gap: 12px;
      padding: 10px 12px;
      background: var(--surface);
      border-top: 1px solid var(--border);
      min-height: 0;
    }
    #artifacts { display: flex; gap: 8px; flex: 0 0 auto; align-items: center; }
    .tile {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 7px 11px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg);
      text-decoration: none;
      color: var(--text);
      min-width: 88px;
    }
    a.tile:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
    .tile .k { font-size: 11px; color: var(--muted); }
    .tile .v { font-family: var(--mono); font-size: 12px; font-variant-numeric: tabular-nums; }

    #rawlog {
      flex: 1 1 auto;
      min-width: 0;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg);
      overflow: hidden;
    }
    #rawlog > summary {
      cursor: pointer;
      list-style: none;
      padding: 7px 11px;
      font-size: 12px;
      color: var(--muted);
      user-select: none;
    }
    #rawlog > summary::-webkit-details-marker { display: none; }
    #rawlog > summary::before { content: "\\25B8"; display: inline-block; margin-right: 6px; }
    #rawlog[open] > summary::before { transform: rotate(90deg); }
    .rawlist {
      max-height: 140px;
      overflow-y: auto;
      padding: 2px 11px 10px;
      font-family: var(--mono);
      font-size: 11px;
    }
    .rawrow { display: flex; gap: 12px; padding: 2px 0; color: var(--text); }
    .rawrow .ts { color: var(--muted); }
    .rawrow .ty { color: var(--text); }

    ::-webkit-scrollbar { width: 9px; height: 9px; }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }

    /* ── Waiting label (device pane, before first frame) ───────── */
    #waiting-label {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      color: var(--muted);
      pointer-events: none;
      letter-spacing: 0.2px;
    }

    /* ── Timeline empty / skeleton states ───────────────────────── */
    .tl-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--muted);
      font-size: 13px;
      letter-spacing: 0.2px;
    }
    .skel-row {
      display: flex;
      align-items: baseline;
      gap: 10px;
      padding: 7px 10px;
      border: 1px solid transparent;
      border-radius: var(--radius);
    }
    .skel-g {
      flex: 0 0 14px;
      height: 13px;
      border-radius: 3px;
      background: var(--surface);
    }
    .skel-line {
      height: 12px;
      border-radius: 3px;
      background: var(--surface);
    }

    @media (prefers-reduced-motion: no-preference) {
      #run-status.is-running, #live-badge:not(.snapshot) { animation: pulse 1.8s ease-in-out infinite; }
      @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
      .step.expanded { animation: reveal 0.18s ease-out; }
      @keyframes reveal { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
      .step.expanded.running { transition: box-shadow 0.2s, border-color 0.2s; }
      #rawlog > summary::before { transition: transform 0.12s; }
      .skel-g, .skel-line { animation: shimmer 1.4s ease-in-out infinite; }
      @keyframes shimmer { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }
    }
  </style>
</head>
<body>
  <div id="statusbar">
    <span class="wordmark">Preflight</span>
    <span id="run-status" class="badge">loading</span>
    <span id="device-label"></span>
    <span id="bundleid" class="chip" hidden></span>
    <span class="metric">steps <span id="step-progress" class="v">0/0</span></span>
    <span class="metric">elapsed <span id="elapsed" class="v">00:00</span></span>
    <span id="test-intent"></span>
  </div>

  <div id="main">
    <div id="device">
      <img id="screen" alt="device screen" />
      <span id="live-badge">LIVE</span>
      <div id="waiting-label">等待首帧…</div>
    </div>
    <div id="timeline"></div>
  </div>

  <div id="bottom">
    <div id="artifacts"></div>
    <details id="rawlog">
      <summary>Raw event log (0)</summary>
      <div class="rawlist" id="rawlist"></div>
    </details>
  </div>

  <script>
    const runId = ${JSON.stringify(runId)};
    const runUrl = '/runs/' + encodeURIComponent(runId);
    const apiUrl = '/api/runs/' + encodeURIComponent(runId);
    const TERMINAL = new Set(['SUCCESS', 'FAILED', 'CANCELLED']);

    function esc(s) { return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

    /* ── Step 2: device sizing guard ──────────────────────────── */
    const screen = document.getElementById('screen');
    const device = document.getElementById('device');
    let terminalReached = false;   // guards screen.src reassignment after terminal status
    function syncDeviceWidth() {
      if (!screen.naturalWidth || !screen.naturalHeight) return;
      device.style.width = (device.clientHeight * screen.naturalWidth / screen.naturalHeight) + 'px';
    }
    screen.addEventListener('load', () => {
      // hide the "waiting for first frame" overlay on the first successful load
      const wl = document.getElementById('waiting-label');
      if (wl) wl.style.display = 'none';
      syncDeviceWidth();
    });
    window.addEventListener('resize', syncDeviceWidth);
    screen.src = runUrl + '/screen.mjpeg';
    screen.onerror = () => {
      if (terminalReached) return;   // run is done — preserve the last frame, do not retry
      const wl = document.getElementById('waiting-label');
      if (wl) wl.style.display = 'none';   // stream failed before first frame; don't keep waiting
      const b = document.getElementById('live-badge');
      b.textContent = 'SNAPSHOT';
      b.classList.add('snapshot');
    };

    /* ── status badge helper ──────────────────────────────────── */
    function setRunStatus(status) {
      const el = document.getElementById('run-status');
      el.textContent = status || 'CREATED';
      el.classList.remove('is-running', 'is-success', 'is-failed');
      const s = String(status || '').toUpperCase();
      if (s === 'RUNNING') el.classList.add('is-running');
      else if (s === 'SUCCESS') el.classList.add('is-success');
      else if (s === 'FAILED' || s === 'CANCELLED') el.classList.add('is-failed');
    }

    /* ── Step 3: SSE client + revision-driven dump refresh ────── */
    let lastRev = -1, pinned = null, followLive = true;
    let lastSteps = [];
    let skeletonCount = 4;   // refined once we fetch meta; used before first dump
    let terminalDraining = false;   // re-entry guard for the one-shot terminal cleanup
    const es = new EventSource(runUrl + '/events');
    es.onmessage = (e) => {
      const m = JSON.parse(e.data);
      setRunStatus(m.status);
      if (m.bundleId) {
        const chip = document.getElementById('bundleid');
        chip.textContent = m.bundleId;
        chip.hidden = false;
      }
      const isTerminal = !!m.status && TERMINAL.has(String(m.status).toUpperCase());
      if (isTerminal) stopTimer();
      if (typeof m.revision === 'number' && m.revision !== lastRev) {   // normal revision-driven refresh
        lastRev = m.revision;
        refreshDump();
        refreshMeta();
      }
      if (isTerminal && !terminalDraining) {   // terminal cleanup: revision-INDEPENDENT, runs once
        terminalDraining = true;
        // The terminal tick usually carries the SAME revision as the last step,
        // so this must NOT be gated behind the revision guard above. Do one final
        // dump+meta refresh, then stop everything regardless of refresh outcome.
        refreshDump().then(() => refreshMeta()).finally(() => {
          terminalReached = true;  // after final refresh: block screen.onerror retries
          es.close();
        });
      }
    };
    setInterval(() => { if (!terminalReached) refreshDump(); }, 15000); // fallback poll: covers a silently-wedged SSE (no error event, mid-run) until terminal
    let firstDumpDone = false;
    async function refreshDump() {
      try {
        const view = await (await fetch(runUrl + '/dump')).json();
        firstDumpDone = true;
        renderTimeline(view.steps || []);
      } catch (_) { /* network error; keep showing whatever is rendered */ }
    }

    /* ── Step 4: timeline render ──────────────────────────────── */
    // Shared step-markup builders, injected verbatim from src/mcp/live/timelineMarkup.ts
    // so the live page and the evidence renderer use the exact same code. Free-variable split:
    //   - GLYPH and dataHTML are injected here (const + .toString() below).
    //   - esc and escAttr are NOT injected — the injected bodies resolve them to this script's
    //     own esc()/escAttr() defs, which are kept behaviorally identical to the module's copies.
    // Do not add a builder free variable without injecting it here or defining it identically below.
    const GLYPH = ${JSON.stringify(GLYPH)};
    ${dataHTML.toString()}
    ${stepCollapsedHTML.toString()}
    ${stepExpandedHTML.toString()}
    function currentIndex(steps) {
      const r = steps.find(s => s.status === 'running');
      return r ? r.index : (steps.filter(s => s.status !== 'pending').slice(-1)[0]?.index);
    }
    function renderTimeline(steps) {
      lastSteps = steps;
      if (pinned != null && !steps.some(s => s.index === pinned)) { pinned = null; followLive = true; }  // stale pin -> resume follow
      const sel = pinned ?? (followLive ? currentIndex(steps) : null);
      const root = document.getElementById('timeline');
      if (steps.length === 0) {
        root.innerHTML = '<div class="tl-empty">尚无步骤</div>';
        updateProgress(steps);
        return;
      }
      // Bake the live screenshot URLs (host rewrite + cache-bust) onto each step BEFORE
      // handing it to the shared builders, which emit step.screenshots verbatim.
      root.innerHTML = steps.map(s => {
        const live = { ...s, screenshots: (s.screenshots || []).map(rel => runUrl + '/report/' + encodeURI(rel) + '?_rev=' + lastRev) };
        return live.index === sel ? stepExpandedHTML(live) : stepCollapsedHTML(live);
      }).join('');
      root.querySelectorAll('[data-step]').forEach(el =>
        el.addEventListener('click', (e) => {
          if (e.target.closest && e.target.closest('.strip')) return;  // let users click screenshots without collapsing the card
          const idx = Number(el.dataset.step);
          if (pinned === idx) { pinned = null; followLive = true; }   // click the pinned/running step again -> resume auto-follow
          else { pinned = idx; followLive = false; }                  // click another step -> pin it
          renderTimeline(steps);
        }));
      updateProgress(steps);
    }
    function renderSkeleton(n) {
      const root = document.getElementById('timeline');
      // Only render skeleton if the first real dump hasn't arrived yet
      if (firstDumpDone) return;
      const widths = [55, 70, 45, 62, 50, 68, 40, 58];
      root.innerHTML = Array.from({ length: n }, (_, i) =>
        '<div class="skel-row"><div class="skel-g"></div>'
        + '<div style="flex:1;display:flex;align-items:center;gap:8px">'
        + '<div class="skel-line" style="width:' + widths[i % widths.length] + '%"></div>'
        + '</div></div>'
      ).join('');
    }
    function updateProgress(steps) {
      const total = steps.length;
      const executed = steps.filter(s => s.status !== 'pending').length;
      document.getElementById('step-progress').textContent = executed + '/' + total;
    }

    /* ── Step 5: bottom strip (artifacts + collapsed raw log) ──── */
    function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }
    function renderMeta(run) {
      const label = [run.platform, run.resourceId].filter(Boolean).join(' \\u00B7 ');
      document.getElementById('device-label').textContent = label;
      document.getElementById('test-intent').textContent = run.testIntent || '';
      document.getElementById('test-intent').title = run.testIntent || '';
      if (run.task && run.task.status) setRunStatus(run.task.status);
      renderArtifacts(run.artifacts || []);
      renderRawLog(run.events || []);
      if (run.createdAt) startedAt = Date.parse(run.createdAt) || startedAt;
    }
    function renderArtifacts(artifacts) {
      const tiles = [];
      const byType = (t) => artifacts.find(a => (a.type || '').toLowerCase().includes(t));
      const report = byType('report') || artifacts.find(a => /report\\.html$/i.test(a.uri || ''));
      const recording = byType('recording') || byType('video') || artifacts.find(a => /\\.mp4$/i.test(a.uri || ''));
      const shotCount = artifacts.filter(a => (a.type || '').toLowerCase().includes('screenshot') || /\\.png$/i.test(a.uri || '')).length;
      if (report) tiles.push('<a class="tile" href="' + escAttr(report.uri) + '" target="_blank" rel="noreferrer"><span class="k">report</span><span class="v">report.html</span></a>');
      if (recording) tiles.push('<a class="tile" href="' + escAttr(recording.uri) + '" target="_blank" rel="noreferrer"><span class="k">recording</span><span class="v">recording.mp4</span></a>');
      tiles.push('<div class="tile"><span class="k">screenshots</span><span class="v">' + shotCount + '</span></div>');
      document.getElementById('artifacts').innerHTML = tiles.join('');
    }
    function renderRawLog(events) {
      document.querySelector('#rawlog > summary').textContent = 'Raw event log (' + events.length + ')';
      document.getElementById('rawlist').innerHTML = events.map(ev =>
        '<div class="rawrow"><span class="ts">' + esc(ev.timestamp || '') + '</span><span class="ty">' + esc(ev.type || '') + '</span></div>'
      ).join('');
    }
    async function refreshMeta() {
      try {
        const run = await (await fetch(apiUrl)).json();
        // Refine skeleton count from actual visualFlow step count (top-level only)
        if (!firstDumpDone && run.visualFlow && Array.isArray(run.visualFlow.steps)) {
          skeletonCount = run.visualFlow.steps.length || 4;
          renderSkeleton(skeletonCount);
        }
        renderMeta(run);
      } catch (_) { /* network error; keep current UI */ }
    }

    /* ── elapsed timer ────────────────────────────────────────── */
    let startedAt = Date.now();
    function fmtElapsed(ms) {
      const total = Math.max(0, Math.floor(ms / 1000));
      const mm = String(Math.floor(total / 60)).padStart(2, '0');
      const ss = String(total % 60).padStart(2, '0');
      return mm + ':' + ss;
    }
    function tick() { document.getElementById('elapsed').textContent = fmtElapsed(Date.now() - startedAt); }
    let timer = setInterval(tick, 1000);
    function stopTimer() { if (timer) { clearInterval(timer); timer = null; } tick(); }

    /* ── boot ─────────────────────────────────────────────────── */
    renderSkeleton(skeletonCount);  // show skeleton immediately; replaced by real rows on first dump
    refreshMeta();                  // refines skeleton count then updates status bar
    tick();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[char] ?? char));
}
