import { createServer, request as httpRequest, IncomingMessage, ServerResponse, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import type { NetworkMockRule, NetworkMockResponse, NetworkMockStats } from "./types.js";
import { compileHandlerInvocation, runHandler, type HandlerReq, type HandlerResp } from "./handler.js";
import vm from "node:vm";
import tls from "node:tls";
import { TLSSocket } from "node:tls";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface CertKeyPair {
  key: string;
  cert: string;
}

function findJsonValue(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  if (key in (obj as Record<string, unknown>)) return (obj as Record<string, unknown>)[key];
  for (const v of Object.values(obj as Record<string, unknown>)) {
    const result = findJsonValue(v, key);
    if (result !== undefined) return result;
  }
  return undefined;
}

function getRuleKey(rule: NetworkMockRule): string {
  return [rule.hostRegex, rule.pathPattern ?? "", rule.pathRegex ?? "", rule.method ?? ""].join("||");
}

export class NetworkMockServer {
  private server: Server | null = null;
  private rules: NetworkMockRule[] = [];
  private callCounts = new Map<string, number>();
  private port = 0;
  private rootCA: CertKeyPair | null = null;
  private certCache = new Map<string, tls.SecureContext>();
  private mitmHttpServer: Server | null = null;
  private recording = false;
  private recorded: { url: string; method: string; requestBody: string; responseBody: string; status: number }[] = [];
  /** Per-rule compiled handler invocation script, keyed by getRuleKey; compiled once at start()/updateRules(). */
  private handlerScripts = new Map<string, vm.Script>();
  private static readonly REQ_BODY_CAP = 10_000;
  private static readonly RES_BODY_CAP = 500_000;

  start(rules: NetworkMockRule[], bindAddress = "0.0.0.0", preferredPort = 0): Promise<number> {
    this.rules = rules;
    this.callCounts.clear();
    this.certCache.clear();
    this.rootCA = this.loadOrGenerateRootCA();
    for (const rule of rules) {
      this.callCounts.set(getRuleKey(rule), 0);
    }
    this.compileHandlers();
    this.mitmHttpServer = createServer((req, res) => {
      // hostname/port are stored on the socket during handleConnectEvent
      const sock = req.socket as any;
      void this.handleMitmRequest(req, res, sock.__mitmHostname ?? "unknown", sock.__mitmPort ?? 443);
    });
    this.mitmHttpServer.on("error", () => {});

    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));
      this.server.on("connect", (req, socket, head) => this.handleConnectEvent(req, socket, head));
      this.server.on("error", reject);
      this.server.listen(preferredPort, bindAddress, () => {
        const addr = this.server!.address();
        if (!addr || typeof addr === "string") { reject(new Error("Failed to get server address")); return; }
        this.port = addr.port;
        resolve(this.port);
      });
    });
  }

  stop(): Promise<void> {
    this.certCache.clear();
    return new Promise((resolve) => {
      if (this.mitmHttpServer) { this.mitmHttpServer.close(); this.mitmHttpServer = null; }
      if (!this.server) return resolve();
      this.server.close(() => { this.server = null; this.port = 0; resolve(); });
    });
  }

  getPort(): number { return this.port; }
  getRootCACert(): string | null { return this.rootCA?.cert ?? null; }

  /** Generate an iOS .mobileconfig profile that installs the CA cert + proxy settings. */
  generateMobileConfig(proxyHost: string, proxyPort: number): string | null {
    if (!this.rootCA) return null;
    const payloadContent = this.rootCA.cert
      .replace(/-----BEGIN CERTIFICATE-----/, "")
      .replace(/-----END CERTIFICATE-----/, "")
      .replace(/\n/g, "");
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>Preflight Mock CA</string>
      <key>PayloadContent</key>
      <data>${payloadContent}</data>
      <key>PayloadDescription</key>
      <string>信任此证书以启用 Preflight HTTPS 拦截</string>
      <key>PayloadDisplayName</key>
      <string>Preflight Mock CA</string>
      <key>PayloadIdentifier</key>
      <string>com.preflight.ca</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>${randomUUID().toUpperCase()}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
    <dict>
      <key>PayloadContent</key>
      <dict>
        <key>HTTPProxy</key>
        <string>${proxyHost}</string>
        <key>HTTPPort</key>
        <integer>${proxyPort}</integer>
        <key>HTTPSProxy</key>
        <string>${proxyHost}</string>
        <key>HTTPSPort</key>
        <integer>${proxyPort}</integer>
        <key>ProxyAutoConfigEnable</key>
        <false/>
        <key>ProxyAutoDiscoveryEnable</key>
        <false/>
      </dict>
      <key>PayloadDescription</key>
      <string>配置 WiFi 代理到 Preflight Mock Server</string>
      <key>PayloadDisplayName</key>
      <string>WiFi Proxy (Preflight)</string>
      <key>PayloadIdentifier</key>
      <string>com.preflight.proxy</string>
      <key>PayloadType</key>
      <string>com.apple.SystemConfiguration</string>
      <key>PayloadUUID</key>
      <string>${randomUUID().toUpperCase()}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>安装 Preflight Mock CA 证书和 WiFi 代理配置。安装后前往 Settings > General > About > Certificate Trust Settings 开启信任。</string>
  <key>PayloadDisplayName</key>
  <string>Preflight Network Mock</string>
  <key>PayloadIdentifier</key>
  <string>com.preflight.mocks</string>
  <key>PayloadOrganization</key>
  <string>Preflight</string>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${randomUUID().toUpperCase()}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>`;
  }

  getStats(): NetworkMockStats {
    return {
      running: this.server !== null,
      port: this.port,
      mitmEnabled: this.rootCA !== null,
      rules: this.rules.map((rule) => ({
        hostRegex: rule.hostRegex,
        description: rule.description,
        callCount: this.callCounts.get(getRuleKey(rule)) ?? 0,
      })),
    };
  }

  updateRules(rules: NetworkMockRule[]): void {
    this.rules = rules;
    this.callCounts.clear();
    for (const rule of rules) {
      this.callCounts.set(getRuleKey(rule), 0);
    }
    this.compileHandlers();
  }

  /**
   * Compile each rule's handler invocation once and cache by rule key. Validation already
   * syntax-checks handlers, but compile defensively here and skip a rule whose handler fails to
   * compile (it then falls through to passthrough rather than throwing at request time).
   */
  private compileHandlers(): void {
    this.handlerScripts.clear();
    for (const rule of this.rules) {
      if (!rule.handler) continue;
      try {
        this.handlerScripts.set(getRuleKey(rule), compileHandlerInvocation(rule.handler));
      } catch { /* skip uncompilable handler → passthrough */ }
    }
  }

  setRecording(enabled: boolean): void {
    this.recording = enabled;
    if (enabled) this.recorded = [];
  }

  clearRecording(): void { this.recorded = []; }

  isRecording(): boolean { return this.recording; }
  getRecordedCount(): number { return this.recorded.length; }

  exportRecordedRules(): NetworkMockRule[] {
    const dedup = new Map<string, { url: string; hostname: string; pathname: string; method?: string; requestBodies: Map<string, number> }>();
    for (const r of this.recorded) {
      const key = r.url;
      let entry = dedup.get(key);
      if (!entry) {
        let hostname = "";
        let pathname = r.url;
        try { const u = new URL(r.url); hostname = u.hostname; pathname = u.pathname; } catch {}
        entry = { url: r.url, hostname, pathname, method: r.method !== "GET" ? r.method : undefined, requestBodies: new Map() };
        dedup.set(key, entry);
      }
      const bodyKey = r.requestBody || "(empty)";
      entry.requestBodies.set(bodyKey, (entry.requestBodies.get(bodyKey) ?? 0) + 1);
    }
    const rules: NetworkMockRule[] = [];
    for (const entry of dedup.values()) {
      const responses = this.recorded
        .filter((r) => r.url === entry.url)
        .map((r, i) => {
          const resp: NetworkMockResponse = {
            status: r.status,
            body: r.responseBody.slice(0, 500_000),
          };
          if (i > 0) resp.callIndex = i + 1;
          if (r.requestBody) {
            try {
              const parsed = JSON.parse(r.requestBody);
              const flat: Record<string, string> = {};
              for (const [k, v] of Object.entries(parsed)) {
                if (typeof v === "string") flat[k] = v;
                else if (typeof v === "number" || typeof v === "boolean") flat[k] = String(v);
              }
              if (Object.keys(flat).length > 0) resp.requestBodyMatch = flat;
            } catch { /* ignore */ }
          }
          return resp;
        });
      // Escape special regex chars in the recorded hostname for a safe literal match
      const escapedHost = entry.hostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      rules.push({
        hostRegex: escapedHost,
        ...(entry.pathname && entry.pathname !== "/" ? { pathPattern: entry.pathname } : {}),
        ...(entry.method ? { method: entry.method as NetworkMockRule["method"] } : {}),
        responses: responses.slice(0, 50),
        description: "recorded",
      });
    }
    return rules;
  }

  // ── HTTP proxy handler ──

  private handleRequest(clientReq: IncomingMessage, clientRes: ServerResponse): void {
    if (clientReq.method === "CONNECT") return;
    const requestUrl = this.resolveUrl(clientReq);
    if (!requestUrl) { clientRes.writeHead(400); clientRes.end(); return; }
    const method = clientReq.method ?? "GET";
    const rule = this.findMatchingRule(method, requestUrl);
    if (rule?.handler) {
      void this.handleViaHandler(rule, clientReq, clientRes, requestUrl, false);
      return;
    }
    // NOTE: requestBodyMatch matching remains a known limitation — the request body is not buffered
    // before findMatch (it is teed during forward, which is too late for matching).
    const match = this.findMatch(method, requestUrl);
    match ? this.serveMock(match, clientRes) : this.forwardRequest(clientReq, clientRes, requestUrl);
  }

  private resolveUrl(req: IncomingMessage): URL | null {
    if (req.url && (req.url.startsWith("http://") || req.url.startsWith("https://"))) {
      try { return new URL(req.url); } catch { return null; }
    }
    if (req.headers.host && req.url) {
      try { return new URL(req.url, `http://${req.headers.host}`); } catch { return null; }
    }
    return null;
  }

  // ── Inline JS handler dispatch ──

  /**
   * Run a matched rule's inline JS handler. Buffers the full request body (so the handler can read
   * rawBody/json), provides ctx.fetchReal (a single memoized upstream fetch), then either serves the
   * HandlerResp or — on null/throw/timeout — falls through to the real response. The upstream is
   * fetched at most once: if the handler awaited fetchReal and then returned null, the buffered real
   * response is reused for the passthrough rather than re-sent.
   */
  private async handleViaHandler(
    rule: NetworkMockRule,
    clientReq: IncomingMessage,
    clientRes: ServerResponse,
    url: URL,
    isHttps: boolean,
    hostname = url.hostname,
    port = isHttps ? 443 : Number(url.port) || 80,
  ): Promise<void> {
    const method = clientReq.method ?? "GET";
    const headers: Record<string, unknown> = { ...clientReq.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];

    const rawBody = await this.readBody(clientReq);
    const contentType = String(clientReq.headers["content-type"] ?? "").toLowerCase();
    let json: unknown;
    if (rawBody && contentType.includes("json")) {
      try { json = JSON.parse(rawBody); } catch { json = undefined; }
    }
    const req: HandlerReq = {
      method,
      host: url.hostname,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers,
      rawBody,
      json,
    };

    // Memoize the real upstream fetch so it runs at most once across fetchReal + passthrough.
    let realPromise: Promise<{ status: number; headers: Record<string, unknown>; body: string }> | null = null;
    const fetchReal = () => {
      if (!realPromise) realPromise = this.fetchUpstream(method, url, headers, rawBody, isHttps, hostname, port);
      return realPromise;
    };

    const resp = await runHandler(rule.handler!, req, { fetchReal }, 5000, this.handlerScripts.get(getRuleKey(rule)));

    if (resp != null) {
      this.serveHandlerResp(resp, clientRes);
      return;
    }
    // Fall through to the real response (passthrough). Reuse the buffered upstream if fetchReal ran.
    try {
      const real = await fetchReal();
      if (!clientRes.headersSent) { clientRes.writeHead(real.status, real.headers as any); clientRes.end(real.body); }
    } catch {
      if (!clientRes.headersSent) { clientRes.writeHead(502); clientRes.end("Bad Gateway"); }
    }
  }

  /** Read a request body into a capped string (REQ_BODY_CAP). Resolves once the stream ends. */
  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let captured = 0;
      req.on("data", (chunk: Buffer) => {
        if (captured < NetworkMockServer.REQ_BODY_CAP) {
          const take = chunk.subarray(0, NetworkMockServer.REQ_BODY_CAP - captured);
          chunks.push(take);
          captured += take.length;
        }
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString()));
      req.on("error", () => resolve(Buffer.concat(chunks).toString()));
    });
  }

  /**
   * Perform the real upstream request with a buffered body and resolve the FULLY buffered response
   * (capped at RES_BODY_CAP). Used by ctx.fetchReal and the handler-null passthrough.
   */
  private fetchUpstream(
    method: string,
    url: URL,
    headers: Record<string, unknown>,
    body: string,
    isHttps: boolean,
    hostname: string,
    port: number,
  ): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
    return new Promise((resolve, reject) => {
      const outHeaders: Record<string, unknown> = { ...headers };
      // We send a buffered body; drop any client-provided content-length so the client recomputes it.
      delete outHeaders["content-length"];
      const opts: any = {
        hostname,
        port,
        path: url.pathname + url.search,
        method,
        headers: outHeaders,
        ...(isHttps ? { rejectUnauthorized: false } : {}),
      };
      const reqFn = isHttps ? httpsRequest : httpRequest;
      const pr = reqFn(opts, (pres) => {
        const chunks: Buffer[] = [];
        let captured = 0;
        pres.on("data", (chunk: Buffer) => {
          if (captured < NetworkMockServer.RES_BODY_CAP) {
            const take = chunk.subarray(0, NetworkMockServer.RES_BODY_CAP - captured);
            chunks.push(take);
            captured += take.length;
          }
        });
        pres.on("end", () => resolve({ status: pres.statusCode ?? 502, headers: pres.headers, body: Buffer.concat(chunks).toString() }));
        pres.on("error", reject);
      });
      pr.on("error", reject);
      if (body) pr.write(body);
      pr.end();
    });
  }

  /** Serve a handler-produced response: object body → JSON; merge handler headers; mark as mock. */
  private serveHandlerResp(resp: HandlerResp, res: ServerResponse): void {
    const status = resp.status ?? 200;
    const handlerHeaders = resp.headers ?? {};
    let body: string;
    const outHeaders: Record<string, string> = { "X-Preflight-Mock": "true", ...handlerHeaders };
    if (typeof resp.body === "string") {
      body = resp.body;
    } else if (resp.body == null) {
      body = "";
    } else {
      body = JSON.stringify(resp.body);
      const hasContentType = Object.keys(handlerHeaders).some((h) => h.toLowerCase() === "content-type");
      if (!hasContentType) outHeaders["Content-Type"] = "application/json; charset=utf-8";
    }
    res.writeHead(status, outHeaders);
    res.end(body);
  }

  /**
   * Shared host/path/method/query gate for a single rule. Used by both findMatch (static-response
   * selection) and findMatchingRule (rule dispatch incl. handler-only rules). A bad regex fails closed.
   */
  private ruleGates(rule: NetworkMockRule, method: string, url: URL): boolean {
    try { if (!new RegExp(rule.hostRegex).test(url.hostname)) return false; } catch { return false; }
    if (rule.pathPattern && !url.pathname.includes(rule.pathPattern)) return false;
    if (rule.pathRegex) { try { if (!new RegExp(rule.pathRegex).test(url.pathname)) return false; } catch { return false; } }
    if (rule.method && rule.method.toUpperCase() !== method.toUpperCase()) return false;
    if (rule.queryParams) {
      for (const [k, v] of Object.entries(rule.queryParams)) { if (url.searchParams.get(k) !== v) return false; }
    }
    return true;
  }

  /**
   * First gate-matching rule that actually produces a mock (has `handler` or `responses`).
   * Record-only rules (neither) are skipped so a later mock rule on the same host still wins —
   * mirroring findMatch's fall-through. The mock point uses this to dispatch handler-only rules
   * (which findMatch can't surface) without letting an earlier record-only rule swallow them.
   */
  private findMatchingRule(method: string, url: URL): NetworkMockRule | null {
    for (const rule of this.rules) {
      if (!this.ruleGates(rule, method, url)) continue;
      if (rule.handler || (rule.responses && rule.responses.length > 0)) return rule;
    }
    return null;
  }

  private findMatch(method: string, url: URL, reqBody?: Record<string, unknown>): NetworkMockResponse | null {
    for (const rule of this.rules) {
      if (!this.ruleGates(rule, method, url)) continue;
      // Record-only (no responses/handler): host matched but no mock response.
      // Fall through so a later mock rule on the same host can still match;
      // do NOT increment callCount for record-only rules.
      if (!rule.responses || rule.responses.length === 0) continue;
      const key = getRuleKey(rule);
      const currentCount = (this.callCounts.get(key) ?? 0) + 1;
      this.callCounts.set(key, currentCount);
      for (const resp of rule.responses) {
        if (resp.callIndex != null && resp.callIndex !== currentCount) continue;
        if (resp.requestBodyMatch && reqBody) {
          let bodyMatch = true;
          for (const [rkey, expected] of Object.entries(resp.requestBodyMatch)) {
            const actual = findJsonValue(reqBody, rkey);
            if (actual === undefined || String(actual) !== expected) { bodyMatch = false; break; }
          }
          if (!bodyMatch) continue;
        }
        return resp;
      }
      return null;
    }
    return null;
  }

  private serveMock(mock: NetworkMockResponse, res: ServerResponse): void {
    const { status = 200, body, headers = {}, delay = 0 } = mock;
    const send = () => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "X-Preflight-Mock": "true",
        ...headers,
      });
      res.end(body);
    };
    delay > 0 ? setTimeout(send, delay) : send();
  }

  private forwardRequest(clientReq: IncomingMessage, clientRes: ServerResponse, url: URL): void {
    const opts: any = {
      hostname: url.hostname, port: url.port || 80,
      path: url.pathname + url.search, method: clientReq.method,
      headers: { ...clientReq.headers },
    };
    delete opts.headers["proxy-connection"];

    const recordUrl = this.recording && this.recorded.length < 1000 ? url.toString() : undefined;
    const method = clientReq.method ?? "GET";
    const reqChunks = this.teeRequestBody(clientReq, recordUrl);

    const pr = httpRequest(opts, (pres) => {
      const status = pres.statusCode ?? 502;
      clientRes.writeHead(status, pres.headers);
      // pipe() handles backpressure (drain) and auto-ends clientRes
      pres.pipe(clientRes);
      pres.on("error", () => clientRes.end());
      if (recordUrl) this.recordTee(pres, reqChunks, { url: recordUrl, method, status });
    });

    pr.on("error", () => { if (!clientRes.headersSent) { clientRes.writeHead(502); clientRes.end("Bad Gateway"); } });
    clientReq.pipe(pr);
  }

  /**
   * Tee request body chunks into a capped buffer (for recording). Returns the chunk array
   * that recordTee will concat on response end. Returns null when not recording.
   */
  private teeRequestBody(clientReq: IncomingMessage, recordUrl?: string): Buffer[] | null {
    if (!recordUrl) return null;
    const reqChunks: Buffer[] = [];
    let captured = 0;
    clientReq.on("data", (chunk: Buffer) => {
      if (captured < NetworkMockServer.REQ_BODY_CAP) {
        const take = chunk.slice(0, NetworkMockServer.REQ_BODY_CAP - captured);
        reqChunks.push(take);
        captured += take.length;
      }
    });
    return reqChunks;
  }

  /**
   * Observe a piped upstream response (pres is already pipe()'d to the client) to record the full
   * body. Attaching extra data/end listeners to a piped stream is safe and still sees every chunk;
   * the cap stops ACCUMULATING but never stops forwarding bytes (pipe owns delivery).
   */
  private recordTee(
    pres: IncomingMessage,
    reqChunks: Buffer[] | null,
    meta: { url: string; method: string; status: number },
  ): void {
    const resChunks: Buffer[] = [];
    let captured = 0;
    pres.on("data", (chunk: Buffer) => {
      if (captured < NetworkMockServer.RES_BODY_CAP) {
        const take = chunk.slice(0, NetworkMockServer.RES_BODY_CAP - captured);
        resChunks.push(take);
        captured += take.length;
      }
    });
    pres.on("end", () => {
      const requestBody = reqChunks ? Buffer.concat(reqChunks).toString() : "";
      const responseBody = Buffer.concat(resChunks).toString();
      this.recorded.push({ url: meta.url, method: meta.method, requestBody, responseBody, status: meta.status });
    });
  }

  // ── HTTPS MITM handler ──

  private handleConnectEvent(req: IncomingMessage, socket: import("node:stream").Duplex, _head: Buffer): void {
    const sock = socket as unknown as import("node:net").Socket;
    const [hostname, portStr] = (req.url ?? "").split(":");
    const port = Number.parseInt(portStr, 10) || 443;
    if (!hostname) { sock.write("HTTP/1.1 400 Bad Request\r\n\r\n"); sock.destroy(); return; }

    // Skip MITM for connectivity-check domains and non-mocked hosts.
    // Only MITM connections whose hostname matches at least one mock rule;
    // everything else tunnels through so the device stays online.
    if (this.shouldSkipMitm(hostname) || !this.hostnameMatchesAnyRule(hostname)) {
      this.tunnelConnect(sock, hostname, port);
      return;
    }
    const secCtx = this.getServerSecureContext(hostname);
    if (!secCtx) { this.tunnelConnect(sock, hostname, port); return; }

    sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    (sock as any).__mitmHostname = hostname;
    (sock as any).__mitmPort = port;

    const tlsSocket = new TLSSocket(sock, {
      isServer: true,
      secureContext: secCtx,
      ALPNProtocols: ["http/1.1"],
    });
    (tlsSocket as any).__mitmHostname = hostname;
    (tlsSocket as any).__mitmPort = port;
    tlsSocket.on("error", () => { if (!tlsSocket.destroyed) tlsSocket.destroy(); });

    // Route through shared HTTP server
    this.mitmHttpServer!.emit("connection", tlsSocket);
  }

  private async handleMitmRequest(
    innerReq: IncomingMessage,
    innerRes: ServerResponse,
    hostname: string,
    port: number,
  ): Promise<void> {
    const fullUrl = `https://${hostname}${innerReq.url ?? "/"}`;
    let url: URL;
    try { url = new URL(fullUrl); } catch { innerRes.writeHead(400); innerRes.end(); return; }
    const method = innerReq.method ?? "GET";
    const rule = this.findMatchingRule(method, url);
    if (rule?.handler) {
      await this.handleViaHandler(rule, innerReq, innerRes, url, true, hostname, port);
      return;
    }
    // NOTE: requestBodyMatch matching remains a known limitation — the request body is not buffered
    // before findMatch (it is teed during forward, which is too late for matching).
    const match = this.findMatch(method, url);
    if (match) {
      if (this.recording) this.recordMatched(url.toString(), method, match);
      this.serveMock(match, innerRes);
    } else {
      this.forwardHttpsRequest(innerReq, innerRes, hostname, port, this.recording ? url.toString() : undefined);
    }
  }

  private recordMatched(urlStr: string, method: string, mock: NetworkMockResponse): void {
    if (this.recorded.length >= 1000) return;
    this.recorded.push({
      url: urlStr,
      method,
      requestBody: "",
      responseBody: mock.body,
      status: mock.status ?? 200,
    });
  }

  private forwardHttpsRequest(
    clientReq: IncomingMessage,
    clientRes: ServerResponse,
    hostname: string,
    port: number,
    recordUrl?: string,
  ): void {
    const opts: any = {
      hostname, port, path: clientReq.url, method: clientReq.method,
      headers: { ...clientReq.headers }, rejectUnauthorized: false,
    };
    delete opts.headers["proxy-connection"];
    delete opts.headers["proxy-authorization"];

    const method = clientReq.method ?? "GET";
    const record = !!recordUrl && this.recorded.length < 1000 ? recordUrl : undefined;
    const reqChunks = this.teeRequestBody(clientReq, record);

    const pr = httpsRequest(opts, (pres) => {
      const status = pres.statusCode ?? 502;
      clientRes.writeHead(status, pres.headers);
      // pipe() handles backpressure (drain) and auto-ends clientRes
      pres.pipe(clientRes);
      pres.on("error", () => clientRes.end());
      if (record) this.recordTee(pres, reqChunks, { url: record, method, status });
    });

    pr.on("error", () => { if (!clientRes.headersSent) { clientRes.writeHead(502); clientRes.end("Bad Gateway"); } });
    clientReq.pipe(pr);
  }

  private tunnelConnect(sock: import("node:net").Socket, hostname: string, port: number): void {
    let connected = false;
    const upstream = netConnect({ host: hostname, port }, () => {
      connected = true;
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(sock); sock.pipe(upstream);
    });
    upstream.on("error", () => {
      if (!connected) sock.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      upstream.destroy(); sock.destroy();
    });
    sock.on("error", () => upstream.destroy());
    setTimeout(() => {
      if (!connected) { sock.write("HTTP/1.1 504 Gateway Timeout\r\n\r\n"); upstream.destroy(); sock.destroy(); }
    }, 30_000);
  }

  private hostnameMatchesAnyRule(hostname: string): boolean {
    return this.rules.some((rule) => { try { return new RegExp(rule.hostRegex).test(hostname); } catch { return false; } });
  }

  private shouldSkipMitm(hostname: string): boolean {
    const passthroughDomains = [
      // Apple
      ".apple.com",
      ".icloud.com",
      "captive.apple.com",
      "gsp10-ssl.apple.com",
      "gsp11-ssl.apple.com",
      "gsp12-ssl.apple.com",
      "gsp13-ssl.apple.com",
      // Android connectivity checks
      "connectivitycheck.gstatic.com",
      "connectivitycheck.android.com",
      "play.googleapis.com",
      "www.googleapis.com",
      "clients3.google.com",
      // Google captive portal / connectivity
      "google.com",
      ".google.com",
    ];
    return passthroughDomains.some((s) => hostname === s || hostname.endsWith(s));
  }

  // ── Certificate generation (openssl CLI) ──

  private loadOrGenerateRootCA(): CertKeyPair {
    const caDir = join(tmpdir(), "preflight-ca");
    const keyPath = join(caDir, "ca.key");
    const certPath = join(caDir, "ca.pem");
    try {
      const existingKey = readFileSync(keyPath, "utf8");
      const existingCert = readFileSync(certPath, "utf8");
      if (existingKey && existingCert) {
        // Validate the cert works by creating a test context
        try { tls.createSecureContext({ key: existingKey, cert: existingCert }); return { key: existingKey, cert: existingCert }; }
        catch { /* regenerate */ }
      }
    } catch { /* generate new */ }
    const ca = this.generateRootCA();
    try {
      execSync(`mkdir -p "${caDir}"`, { stdio: "pipe" });
      writeFileSync(keyPath, ca.key, { mode: 0o600 });
      writeFileSync(certPath, ca.cert);
    } catch { /* non-fatal */ }
    return ca;
  }

  private generateRootCA(): CertKeyPair {
    const id = randomUUID().slice(0, 8);
    const dir = tmpdir();
    const keyPath = join(dir, `preflight-ca-${id}.key`);
    const certPath = join(dir, `preflight-ca-${id}.pem`);
    try {
      execSync(
        `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${certPath}" -days 3650 ` +
        `-subj "/CN=Preflight Mock CA/O=Preflight/OU=MITM Proxy" ` +
        `-addext "basicConstraints=critical,CA:TRUE" ` +
        `-addext "keyUsage=critical,keyCertSign,cRLSign"`,
        { stdio: "pipe", timeout: 10_000 },
      );
      const key = readFileSync(keyPath, "utf8");
      const cert = readFileSync(certPath, "utf8");
      return { key, cert };
    } finally {
      try { unlinkSync(keyPath); } catch {}
      try { unlinkSync(certPath); } catch {}
    }
  }

  private getServerSecureContext(hostname: string): tls.SecureContext | null {
    if (!this.rootCA) return null;
    const cached = this.certCache.get(hostname);
    if (cached) return cached;
    const { key, cert } = this.generateServerCert(hostname);
    const ctx = tls.createSecureContext({ key, cert });
    this.certCache.set(hostname, ctx);
    return ctx;
  }

  private generateServerCert(hostname: string): CertKeyPair {
    const id = randomUUID().slice(0, 8);
    const dir = tmpdir();
    const keyPath = join(dir, `preflight-srv-${id}.key`);
    const csrPath = join(dir, `preflight-srv-${id}.csr`);
    const certPath = join(dir, `preflight-srv-${id}.pem`);
    const caKeyPath = join(dir, `preflight-ca-${id}.key`);
    const caCertPath = join(dir, `preflight-ca-${id}.pem`);

    try {
      writeFileSync(caKeyPath, this.rootCA!.key);
      writeFileSync(caCertPath, this.rootCA!.cert);

      execSync(`openssl req -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${csrPath}" -subj "/CN=${hostname}"`, { stdio: "pipe", timeout: 10_000 });
      execSync(
        `openssl x509 -req -in "${csrPath}" -CA "${caCertPath}" -CAkey "${caKeyPath}" -CAcreateserial ` +
        `-out "${certPath}" -days 365 -extfile <(printf "subjectAltName=DNS:${hostname}\\nbasicConstraints=CA:FALSE\\nkeyUsage=digitalSignature,keyEncipherment\\nextendedKeyUsage=serverAuth")`,
        { stdio: "pipe", timeout: 10_000, shell: "/bin/bash" },
      );

      const key = readFileSync(keyPath, "utf8");
      const cert = readFileSync(certPath, "utf8");
      return { key, cert };
    } catch {
      // Fall back to tunnel mode if cert generation fails
      throw new Error(`Failed to generate cert for ${hostname}`);
    } finally {
      try { unlinkSync(keyPath); } catch {}
      try { unlinkSync(csrPath); } catch {}
      try { unlinkSync(certPath); } catch {}
      try { unlinkSync(caKeyPath); } catch {}
      try { unlinkSync(caCertPath); } catch {}
    }
  }
}
