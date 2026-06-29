import { NetworkMockServer } from "./NetworkMockServer.js";
import type { NetworkMockStats } from "./types.js";
import type { NetworkMockRule } from "../visual-flow/types.js";
import { configureDeviceProxy, removeDeviceProxy, proxyHostForPlatform } from "./device-proxy.js";
import { ensureCaInstalled } from "./device-ca.js";

export interface NetworkMockServiceStartConfig {
  rules: NetworkMockRule[];
  platform: "android" | "ios";
  deviceId: string;
  preferredPort?: number;
}

export class NetworkMockService {
  private server = new NetworkMockServer();
  private activeConfig: { platform: "android" | "ios"; deviceId: string } | null = null;

  async start(config: NetworkMockServiceStartConfig): Promise<NetworkMockStats> {
    if (this.server.getPort() > 0) {
      await this.stop();
    }
    const port = await this.server.start(config.rules, "0.0.0.0", config.preferredPort ?? 0);
    const proxyHost = proxyHostForPlatform(config.platform);

    // Install the CA BEFORE mutating the device proxy: if it fails, the device
    // is still untouched, so we can throw without leaving a stuck http_proxy.
    // Stop the (already-listening) server on any failure so it isn't orphaned.
    if (config.platform === "android") {
      try {
        const result = await ensureCaInstalled({
          serial: config.deviceId,
          caPemPath: this.server.getRootCaPemPath(),
        });
        if (!result.installed) {
          throw new Error(
            `CA install failed on ${config.deviceId} — the device likely needs a rootable (non-Play-Store) Android image (adb root must succeed), or the cert push was denied.` +
            (result.reason ? ` (${result.reason})` : ""),
          );
        }
      } catch (err) {
        try { await this.server.stop(); } catch { /* best-effort */ }
        throw err;
      }
    }

    // From here on the device gets mutated; if anything throws, roll back so we
    // never leave the proxy set or the server listening.
    try {
      configureDeviceProxy({
        platform: config.platform,
        deviceId: config.deviceId,
        proxyHost,
        proxyPort: port,
      });
      this.activeConfig = { platform: config.platform, deviceId: config.deviceId };
      return this.server.getStats();
    } catch (err) {
      try { await this.stop(); } catch { /* best-effort rollback */ }
      throw err;
    }
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
    await this.server.stop();
    return this.server.getStats();
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
