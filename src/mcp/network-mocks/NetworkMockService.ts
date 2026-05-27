import { NetworkMockServer } from "./NetworkMockServer.js";
import type { NetworkMockStats } from "./types.js";
import type { NetworkMockRule } from "../visual-flow/types.js";
import { configureDeviceProxy, removeDeviceProxy, proxyHostForPlatform } from "./device-proxy.js";

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
    configureDeviceProxy({
      platform: config.platform,
      deviceId: config.deviceId,
      proxyHost,
      proxyPort: port,
    });
    this.activeConfig = { platform: config.platform, deviceId: config.deviceId };
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

  generateMobileConfig(proxyHost: string, proxyPort: number): string | null {
    return this.server.generateMobileConfig(proxyHost, proxyPort);
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
