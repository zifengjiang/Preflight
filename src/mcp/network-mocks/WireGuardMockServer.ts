import { createPrivateKey, createPublicKey } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { NetworkMockRule, NetworkMockStats } from "./types.js";

const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

/**
 * WireGuard transport backed by mitmproxy's userspace WireGuard mode.
 *
 * This backend is intentionally narrow: static NetworkMockRule responses only.
 * Inline JS
 * handlers stay on the Node backend until they can be evaluated in the same
 * sandbox without copying the handler runtime into Python.
 */
export class WireGuardMockServer {
  private process: ChildProcess | null = null;
  private runtimeDir: string | null = null;
  private addonPath: string | null = null;
  private statsPath: string | null = null;
  private keysPath = join(
    process.env.PREFLIGHT_HOME?.trim() || join(homedir(), ".preflight"),
    "network-mock-wireguard",
    "wg.json",
  );
  private rules: NetworkMockRule[] = [];
  private port = 0;

  async start(rules: NetworkMockRule[], preferredPort = 0): Promise<number> {
    if (this.process) await this.stop();
    if (rules.some((rule) => rule.handler)) {
      throw new Error("WireGuard transport currently supports static responses only; handler rules are not supported");
    }

    this.rules = rules;
    const bin = findMitmproxyBinary();
    const port = preferredPort || await findFreeUdpPort();
    const runtimeDir = mkdtempSync(join(tmpdir(), "preflight-wireguard-"));
    const confDir = join(runtimeDir, "conf");
    mkdirSync(confDir, { recursive: true });
    mkdirSync(join(this.keysPath, ".."), { recursive: true });

    // Reuse the stable Preflight CA when one already exists. This keeps the
    // one-time Android trust installation valid across proxy backends.
    const preflightHome = process.env.PREFLIGHT_HOME?.trim() || join(homedir(), ".preflight");
    const caKey = join(preflightHome, "network-mock-ca", "ca.key");
    const caCert = join(preflightHome, "network-mock-ca", "ca.pem");
    if (existsSync(caKey) && existsSync(caCert)) {
      writeFileSync(join(confDir, "mitmproxy-ca.pem"), `${readFileSync(caKey, "utf8")}${readFileSync(caCert, "utf8")}`, { mode: 0o600 });
    }

    this.runtimeDir = runtimeDir;
    this.addonPath = join(runtimeDir, "network_mock.py");
    this.statsPath = join(runtimeDir, "stats.json");
    writeFileSync(this.statsPath, JSON.stringify({ counts: rules.map(() => 0) }));
    this.writeAddon();

    const args = [
      "--set", `confdir=${confDir}`,
      "--mode", `wireguard:${this.keysPath}@0.0.0.0:${port}`,
      "-s", this.addonPath,
      "--quiet",
    ];
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.process = child;
    child.stdout?.resume();
    child.stderr?.resume();
    child.once("exit", () => {
      if (this.process === child) this.process = null;
    });

    try {
      await waitForFile(this.keysPath, child, "WireGuard key file");
      const mitmproxyCaPath = join(confDir, "mitmproxy-ca.pem");
      await waitForFile(mitmproxyCaPath, child, "mitmproxy CA certificate");
      writeFileSync(join(confDir, "ca-cert.pem"), extractCertificate(readFileSync(mitmproxyCaPath, "utf8")));
      this.port = port;
      return port;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const child = this.process;
    this.process = null;
    this.port = 0;
    if (child) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    if (this.runtimeDir) {
      try { rmSync(this.runtimeDir, { recursive: true, force: true }); } catch { /* best effort */ }
      this.runtimeDir = null;
    }
    this.addonPath = null;
    this.statsPath = null;
  }

  getPort(): number { return this.port; }

  getRootCACert(): string | null {
    if (!this.runtimeDir) return null;
    const path = join(this.runtimeDir, "conf", "ca-cert.pem");
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }

  getRootCaPemPath(): string {
    return join(this.runtimeDir ?? "", "conf", "ca-cert.pem");
  }

  getClientConfig(endpointHost: string, tunnelName = "preflight-mock"): string {
    if (!existsSync(this.keysPath)) throw new Error("WireGuard key file is not ready");
    const keys = JSON.parse(readFileSync(this.keysPath, "utf8")) as { server_key?: string; client_key?: string };
    if (!keys.server_key || !keys.client_key) throw new Error("Invalid mitmproxy WireGuard key file");
    const serverPublicKey = x25519PublicKey(keys.server_key);
    const endpoint = endpointHost.includes(":") && !endpointHost.startsWith("[") ? `[${endpointHost}]` : endpointHost;
    return [
      `[Interface]`,
      `PrivateKey = ${keys.client_key}`,
      `Address = 10.0.0.1/32`,
      `DNS = 10.0.0.53`,
      `# Preflight tunnel: ${tunnelName}`,
      "",
      `[Peer]`,
      `PublicKey = ${serverPublicKey}`,
      `AllowedIPs = 0.0.0.0/0`,
      `Endpoint = ${endpoint}:${this.port}`,
      `PersistentKeepalive = 25`,
      "",
    ].join("\n");
  }

  writeClientConfig(path: string, endpointHost: string, tunnelName = "preflight-mock"): void {
    writeFileSync(path, this.getClientConfig(endpointHost, tunnelName), { mode: 0o600 });
  }

  updateRules(rules: NetworkMockRule[]): void {
    if (rules.some((rule) => rule.handler)) {
      throw new Error("WireGuard transport currently supports static responses only; handler rules are not supported");
    }
    this.rules = rules;
    this.writeAddon();
  }

  getStats(): NetworkMockStats {
    let counts: number[] = [];
    if (this.statsPath && existsSync(this.statsPath)) {
      try { counts = (JSON.parse(readFileSync(this.statsPath, "utf8")) as { counts?: number[] }).counts ?? []; } catch { /* stale stats */ }
    }
    return {
      running: this.process !== null && this.port > 0,
      port: this.port,
      mitmEnabled: this.getRootCACert() !== null,
      rules: this.rules.map((rule, index) => ({
        hostRegex: rule.hostRegex,
        description: rule.description,
        callCount: counts[index] ?? 0,
      })),
    };
  }

  setRecording(_enabled: boolean): void {
    throw new Error("recording is not supported by the WireGuard transport yet");
  }

  isRecording(): boolean { return false; }
  getRecordedCount(): number { return 0; }
  exportRecordedRules(): NetworkMockRule[] { return []; }

  private writeAddon(): void {
    if (!this.addonPath || !this.statsPath) return;
    const rules = JSON.stringify(this.rules);
    const statsPath = JSON.stringify(this.statsPath);
    writeFileSync(this.addonPath, String.raw`import json
import re
import time
from urllib.parse import parse_qs, urlsplit
from mitmproxy import http

RULES = ${rules}
STATS_PATH = ${statsPath}
COUNTS = [0 for _ in RULES]

def save_stats():
    try:
        with open(STATS_PATH, "w", encoding="utf-8") as f:
            json.dump({"counts": COUNTS}, f)
    except Exception:
        pass

def host_matches(pattern, host):
    try:
        if isinstance(host, bytes):
            host = host.decode("idna", "ignore")
        host = str(host).strip().rstrip(".")
        return bool(host) and re.search(pattern, host, re.IGNORECASE) is not None
    except (re.error, TypeError, UnicodeError):
        return False

def request_sni(flow):
    return getattr(flow.server_conn, "sni", None) or getattr(flow.client_conn, "sni", None)

def rule_matches(rule, flow):
    request = flow.request
    if not host_matches(rule.get("hostRegex", ""), request_sni(flow) or request.host):
        return False
    path = urlsplit(request.url).path or request.path or "/"
    if rule.get("pathPattern") and rule["pathPattern"] not in path:
        return False
    if rule.get("pathRegex"):
        try:
            if re.search(rule["pathRegex"], path) is None:
                return False
        except re.error:
            return False
    method = rule.get("method")
    if method and method.upper() != request.method.upper():
        return False
    query = parse_qs(urlsplit(request.url).query, keep_blank_values=True)
    if any((query.get(key) or [None])[0] != str(value) for key, value in (rule.get("queryParams") or {}).items()):
        return False
    return True

def tls_clienthello(data):
    sni = getattr(data, "sni", None)
    # Some Android/KOP TLS clients omit SNI. Keep the connection available so
    # request() can apply the host/path gates after mitmproxy parses the URL.
    if not sni:
        return
    if not any(host_matches(rule.get("hostRegex", ""), sni) for rule in RULES):
        data.ignore_connection = True

def request(flow):
    for index, rule in enumerate(RULES):
        responses = rule.get("responses") or []
        if not responses or not rule_matches(rule, flow):
            continue
        COUNTS[index] += 1
        call_index = COUNTS[index]
        response = next((item for item in responses if item.get("callIndex") is None or item.get("callIndex") == call_index), None)
        if response is None:
            continue
        status = response.get("status", 200)
        if not isinstance(status, int) or status < 100 or status > 599:
            status = 200
        body = response.get("body", "")
        if isinstance(body, (dict, list, int, float, bool)):
            body = json.dumps(body, ensure_ascii=False)
        elif body is None:
            body = ""
        else:
            body = str(body)
        headers = {"Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "X-Preflight-Mock": "true"}
        headers.update({str(key): str(value) for key, value in (response.get("headers") or {}).items()})
        delay = response.get("delay", 0) or 0
        if isinstance(delay, (int, float)) and delay > 0:
            time.sleep(delay / 1000)
        flow.response = http.Response.make(status, body.encode("utf-8"), headers)
        save_stats()
        return
    save_stats()

addons = [type("PreflightWireGuardMock", (), {"tls_clienthello": staticmethod(tls_clienthello), "request": staticmethod(request)})()]
`);
    try { chmodSync(this.addonPath, 0o600); } catch { /* best effort */ }
  }
}

function findMitmproxyBinary(): string {
  const configured = process.env.PREFLIGHT_MITMPROXY_BIN?.trim();
  const candidates = configured ? [configured] : [
    "mitmdump",
    "mitmweb",
    "/opt/homebrew/Caskroom/miniconda/base/bin/mitmdump",
    "/opt/homebrew/Caskroom/miniconda/base/bin/mitmweb",
    "/usr/local/bin/mitmdump",
    "/usr/local/bin/mitmweb",
  ];
  for (const candidate of candidates) {
    if (candidate.includes("/")) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    try {
      const found = execFileSync("which", [candidate], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (found) return found;
    } catch { /* try the next candidate */ }
  }
  throw new Error("WireGuard mock requires mitmdump or mitmweb on PATH; set PREFLIGHT_MITMPROXY_BIN to its absolute path");
}

async function findFreeUdpPort(): Promise<number> {
  const dgram = await import("node:dgram");
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", reject);
    socket.bind(0, "0.0.0.0", () => {
      const address = socket.address();
      socket.close(() => resolve(typeof address === "string" ? 0 : address.port));
    });
  });
}

async function waitForFile(path: string, child: ChildProcess, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!existsSync(path)) {
    if (child.exitCode !== null) throw new Error(`${label} was not created; mitmproxy exited with code ${child.exitCode}`);
    if (Date.now() >= deadline) throw new Error(`${label} was not created within 15 seconds`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function extractCertificate(pem: string): string {
  const start = pem.indexOf("-----BEGIN CERTIFICATE-----");
  const end = pem.indexOf("-----END CERTIFICATE-----", start);
  if (start < 0 || end < 0) throw new Error("mitmproxy did not produce a CA certificate");
  return `${pem.slice(start, end + "-----END CERTIFICATE-----".length)}\n`;
}

function x25519PublicKey(privateKeyBase64: string): string {
  const privateKey = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(privateKeyBase64, "base64")]),
    format: "der",
    type: "pkcs8",
  });
  const publicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return publicDer.subarray(-32).toString("base64");
}
