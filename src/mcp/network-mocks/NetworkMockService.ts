import { NetworkMockServer } from "./NetworkMockServer.js";
import type { NetworkMockStats } from "./types.js";
import type { NetworkMockRule } from "../visual-flow/types.js";
import { configureDeviceProxy, removeDeviceProxy, proxyHostForPlatform } from "./device-proxy.js";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface NetworkMockServiceStartConfig {
  rules: NetworkMockRule[];
  platform: "android" | "ios";
  deviceId: string;
  preferredPort?: number;
}

export class NetworkMockService {
  private server = new NetworkMockServer();
  private activeConfig: { platform: "android" | "ios"; deviceId: string } | null = null;
  private certServer: Server | null = null;
  private certServerPort = 0;
  private qrPng: Buffer | null = null;

  async start(config: NetworkMockServiceStartConfig): Promise<NetworkMockStats> {
    if (this.server.getPort() > 0) {
      await this.stop();
    }
    const port = await this.server.start(config.rules, "0.0.0.0", config.preferredPort ?? 0);
    const proxyHost = proxyHostForPlatform(config.platform);
    configureDeviceProxy({
      platform: config.platform,
      deviceId: config.deviceId,
      proxyHost,
      proxyPort: port,
    });
    this.activeConfig = { platform: config.platform, deviceId: config.deviceId };
    if (config.platform === "android") {
      try { this.tryInstallCaOnAndroid(config.deviceId); } catch { /* non-critical */ }
    }
    this.startCertServer(proxyHost, port);
    return this.server.getStats();
  }

  async stop(): Promise<NetworkMockStats> {
    if (this.activeConfig) {
      try {
        removeDeviceProxy(this.activeConfig.platform, this.activeConfig.deviceId);
      } catch {
        // best-effort cleanup
      }
      this.activeConfig = null;
    }
    this.stopCertServer();
    await this.server.stop();
    return this.server.getStats();
  }

  getCertServerUrl(): string | null {
    if (!this.certServer || this.certServerPort === 0) return null;
    const host = proxyHostForPlatform(this.activeConfig?.platform ?? "ios");
    return `http://${host}:${this.certServerPort}`;
  }

  private startCertServer(proxyHost: string, proxyPort: number): void {
    this.stopCertServer();
    const caCert = this.server.getRootCACert();
    const mobileConfig = this.server.generateMobileConfig(proxyHost, proxyPort);
    // Generate QR PNG using Python qrcode library
    const qrUrl = `http://${proxyHost}:0/preflight.mobileconfig`; // port placeholder
    this.qrPng = this.generateQrPng(qrUrl);
    const qrPng = this.qrPng;
    const html = this.buildCertPage(proxyHost, proxyPort);
    this.certServer = createServer((req, res) => {
      const url = req.url ?? "/";
      if (url === "/" || url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } else if (url === "/preflight-ca.pem" && caCert) {
        res.writeHead(200, { "Content-Type": "application/x-pem-file" });
        res.end(caCert);
      } else if (url === "/preflight.mobileconfig" && mobileConfig) {
        res.writeHead(200, { "Content-Type": "application/x-apple-aspen-config" });
        res.end(mobileConfig);
      } else if (url === "/qr.png" && qrPng) {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(qrPng);
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });
    this.certServer.listen(0, "0.0.0.0", () => {
      const addr = this.certServer!.address();
      this.certServerPort = addr && typeof addr !== "string" ? addr.port : 0;
      // Re-generate QR with the actual port
      const actualUrl = `http://${proxyHost}:${this.certServerPort}/preflight.mobileconfig`;
      this.qrPng = this.generateQrPng(actualUrl);
    });
  }

  private stopCertServer(): void {
    if (this.certServer) { this.certServer.close(); this.certServer = null; this.certServerPort = 0; this.qrPng = null; }
  }

  /** Push the root CA cert to an Android emulator's user trust store. */
  private tryInstallCaOnAndroid(deviceId: string): void {
    const caCert = this.server.getRootCACert();
    if (!caCert) return;

    // Compute OpenSSL subject hash (Android uses old-style hash for cert filenames)
    const hash = execSync(`openssl x509 -subject_hash_old -noout`, {
      input: caCert, stdio: ["pipe", "pipe", "pipe"], timeout: 5000,
    }).toString().trim();
    if (!hash) return;

    const pemPath = join(tmpdir(), `preflight-ca-${hash}.pem`);
    try {
      writeFileSync(pemPath, caCert);
      const targetPath = `/data/local/tmp/${hash}.0`;
      execSync(`adb -s ${deviceId} push "${pemPath}" "${targetPath}"`, {
        stdio: "pipe", timeout: 10_000,
      });
      execSync(
        `adb -s ${deviceId} shell "mkdir -p /data/misc/user/0/cacerts-added && cp ${targetPath} /data/misc/user/0/cacerts-added/${hash}.0 && chmod 644 /data/misc/user/0/cacerts-added/${hash}.0"`,
        { stdio: "pipe", timeout: 10_000 },
      );
    } catch { /* cert installation is best-effort */ }
    finally { try { unlinkSync(pemPath); } catch {} }
  }

  private generateQrPng(url: string): Buffer | null {
    try {
      const script = `import qrcode,sys;qrcode.make(sys.argv[1]).save('/dev/stdout')`;
      return execSync(`python3 -c "${script}" "${url}"`, { maxBuffer: 100_000, timeout: 5000 });
    } catch { return null; }
  }

  private buildCertPage(proxyHost: string, proxyPort: number): string {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Preflight Mock</title>
<style>
  body { font-family: -apple-system, sans-serif; text-align: center; padding: 20px; background: #f5f5f7; }
  .card { background: white; border-radius: 16px; padding: 24px; max-width: 400px; margin: 0 auto; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .sub { color: #666; font-size: 13px; margin-bottom: 16px; }
  .qr { margin: 16px 0; }
  .btn { display: inline-block; background: #007aff; color: white; padding: 10px 24px; border-radius: 8px;
         text-decoration: none; font-weight: 600; margin: 6px; font-size: 14px; }
  .steps { text-align: left; font-size: 12px; color: #888; margin-top: 20px; line-height: 1.8; }
</style></head><body>
<div class="card">
  <h1>Preflight Network Mock</h1>
  <p class="sub">Proxy ${proxyHost}:${proxyPort}</p>
  <div class="qr"><img src="qr.png" width="200" alt="QR Code"></div>
  <a class="btn" href="preflight-ca.pem">CA 证书 (PEM)</a>
  <a class="btn" href="preflight.mobileconfig">.mobileconfig</a>
  <div class="steps">
    <b>iOS:</b> 扫描二维码 或下载 .mobileconfig → 安装 →<br>
    Settings > General > About > Certificate Trust Settings<br>
    → 开启 <b>Preflight Mock CA</b><br>
    <b>Android:</b> 下载 PEM → Settings > Security →<br>
    Install certificate > CA certificate
  </div>
</div>
</body></html>`;
  }

  isRunning(): boolean {
    return this.server.getPort() > 0;
  }

  getStats(): NetworkMockStats {
    return this.server.getStats();
  }

  updateRules(rules: NetworkMockRule[]): void {
    this.server.updateRules(rules);
  }

  getRootCACert(): string | null {
    return this.server.getRootCACert();
  }

  setRecording(enabled: boolean): void { this.server.setRecording(enabled); }
  isRecording(): boolean { return this.server.isRecording(); }
  getRecordedCount(): number { return this.server.getRecordedCount(); }
  exportRecordedRules(): import("../visual-flow/types.js").NetworkMockRule[] {
    const rules = this.server.exportRecordedRules();
    this.server.clearRecording();
    return rules;
  }
}
