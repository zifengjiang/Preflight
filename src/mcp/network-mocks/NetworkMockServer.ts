import { createServer, request as httpRequest, IncomingMessage, ServerResponse, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import type { NetworkMockRule, NetworkMockResponse, NetworkMockStats } from "./types.js";
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

  start(rules: NetworkMockRule[], bindAddress = "0.0.0.0", preferredPort = 0): Promise<number> {
    this.rules = rules;
    this.callCounts.clear();
    this.certCache.clear();
    this.rootCA = this.loadOrGenerateRootCA();
    for (const rule of rules) {
      this.callCounts.set(getRuleKey(rule), 0);
    }
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
    // NOTE: requestBodyMatch matching remains a known limitation — the request body is not buffered
    // before findMatch (it is teed during forward, which is too late for matching).
    const match = this.findMatch(clientReq.method ?? "GET", requestUrl);
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

  private findMatch(method: string, url: URL, reqBody?: Record<string, unknown>): NetworkMockResponse | null {
    for (const rule of this.rules) {
      // Host gate: hostRegex must match the request hostname
      try { if (!new RegExp(rule.hostRegex).test(url.hostname)) continue; } catch { continue; }
      // Path gate: pathPattern (substring) and/or pathRegex; both omitted = all paths
      if (rule.pathPattern && !url.pathname.includes(rule.pathPattern)) continue;
      if (rule.pathRegex) { try { if (!new RegExp(rule.pathRegex).test(url.pathname)) continue; } catch { continue; } }
      // Method gate
      if (rule.method && rule.method.toUpperCase() !== method.toUpperCase()) continue;
      // Query params gate
      if (rule.queryParams) {
        let qm = true;
        for (const [k, v] of Object.entries(rule.queryParams)) { if (url.searchParams.get(k) !== v) { qm = false; break; } }
        if (!qm) continue;
      }
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

    const recording = this.recording && this.recorded.length < 1000;
    const urlStr = url.toString();
    const method = clientReq.method ?? "GET";
    const REQ_CAP = 10_000;
    const RES_CAP = 500_000;

    // Tee request body for recording (captured in parallel with the pipe to origin)
    const reqChunks: Buffer[] = [];
    let reqCaptured = 0;
    if (recording) {
      clientReq.on("data", (chunk: Buffer) => {
        if (reqCaptured < REQ_CAP) {
          const take = chunk.slice(0, REQ_CAP - reqCaptured);
          reqChunks.push(take);
          reqCaptured += take.length;
        }
      });
    }

    const pr = httpRequest(opts, (pres) => {
      const status = pres.statusCode ?? 502;
      clientRes.writeHead(status, pres.headers);

      if (recording) {
        // Tee response body: accumulate chunks into a capped buffer, pipe concurrently to client
        const resChunks: Buffer[] = [];
        let resCaptured = 0;
        pres.on("data", (chunk: Buffer) => {
          // Always forward to client
          clientRes.write(chunk);
          // Accumulate up to cap for recording
          if (resCaptured < RES_CAP) {
            const take = chunk.slice(0, RES_CAP - resCaptured);
            resChunks.push(take);
            resCaptured += take.length;
          }
        });
        pres.on("end", () => {
          clientRes.end();
          const reqBody = Buffer.concat(reqChunks).toString();
          const responseBody = Buffer.concat(resChunks).toString();
          this.recorded.push({ url: urlStr, method, requestBody: reqBody, responseBody, status });
        });
        pres.on("error", () => { if (!clientRes.headersSent) clientRes.end(); });
      } else {
        pres.pipe(clientRes);
      }
    });

    pr.on("error", () => { if (!clientRes.headersSent) { clientRes.writeHead(502); clientRes.end("Bad Gateway"); } });
    clientReq.pipe(pr);
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
    // NOTE: requestBodyMatch matching remains a known limitation — the request body is not buffered
    // before findMatch (it is teed during forward, which is too late for matching).
    const match = this.findMatch(innerReq.method ?? "GET", url);
    if (match) {
      if (this.recording) this.recordMatched(url.toString(), innerReq.method ?? "GET", match);
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
    const recording = !!recordUrl && this.recorded.length < 1000;
    const REQ_CAP = 10_000;
    const RES_CAP = 500_000;

    // Tee request body for recording
    const reqChunks: Buffer[] = [];
    let reqCaptured = 0;
    if (recording) {
      clientReq.on("data", (chunk: Buffer) => {
        if (reqCaptured < REQ_CAP) {
          const take = chunk.slice(0, REQ_CAP - reqCaptured);
          reqChunks.push(take);
          reqCaptured += take.length;
        }
      });
    }

    const pr = httpsRequest(opts, (pres) => {
      const status = pres.statusCode ?? 502;
      clientRes.writeHead(status, pres.headers);

      if (recording) {
        const resChunks: Buffer[] = [];
        let resCaptured = 0;
        pres.on("data", (chunk: Buffer) => {
          clientRes.write(chunk);
          if (resCaptured < RES_CAP) {
            const take = chunk.slice(0, RES_CAP - resCaptured);
            resChunks.push(take);
            resCaptured += take.length;
          }
        });
        pres.on("end", () => {
          clientRes.end();
          const reqBody = Buffer.concat(reqChunks).toString();
          const responseBody = Buffer.concat(resChunks).toString();
          this.recorded.push({ url: recordUrl!, method, requestBody: reqBody, responseBody, status });
        });
        pres.on("error", () => { if (!clientRes.headersSent) clientRes.end(); });
      } else {
        pres.pipe(clientRes);
      }
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
