import { execFileSync } from "node:child_process";
import { NetworkMockServer } from "./NetworkMockServer.js";
import type { NetworkMockStats } from "./types.js";
import type { NetworkMockRule } from "../visual-flow/types.js";
import { configureDeviceProxy, removeDeviceProxy, proxyHostForPlatform } from "./device-proxy.js";
import { ensureCaInstalled } from "./device-ca.js";

export interface NetworkMockServiceStartConfig {
  rules: NetworkMockRule[];
  /** Android-only in v1; start() still rejects anything else at runtime. */
  platform: "android";
  deviceId: string;
  preferredPort?: number;
}

// TTL for waitForCompletion:false runs — 30 minutes.
const ABANDONED_RUN_TTL_MS = 30 * 60 * 1000;

export class NetworkMockService {
  private server = new NetworkMockServer();
  private activeConfig: { platform: "android" | "ios"; deviceId: string } | null = null;

  // ITEM 2: which runId "owns" the current mock session (null = manual session)
  private _ownerRunId: string | null = null;

  // ITEM 3: TTL handle for abandoned waitForCompletion:false runs
  _ttlTimer: ReturnType<typeof setTimeout> | null = null;

  // ITEM 3: process-exit failsafe — registered at most once per service instance
  private _exitHandlerRegistered = false;
  private _exitHandler: (() => void) | null = null;
  private _sigintHandler: (() => void) | null = null;
  private _sigtermHandler: (() => void) | null = null;

  // ── ITEM 2 public API ──────────────────────────────────────────────────────

  get ownerRunId(): string | null {
    return this._ownerRunId;
  }

  setOwnerRunId(id: string | null): void {
    this._ownerRunId = id;
  }

  /**
   * Returns true only if this runId is the owner of the current mock session.
   * A null ownerRunId (manual session) never returns true.
   * Callers should also check isRunning() before acting.
   */
  shouldTearDownFor(runId: string): boolean {
    return this._ownerRunId !== null && this._ownerRunId === runId;
  }

  // ── ITEM 3 TTL ────────────────────────────────────────────────────────────

  /** Arm a TTL after which the mock is force-stopped if still running. */
  armTtl(ms: number = ABANDONED_RUN_TTL_MS): void {
    this._clearTtl();
    this._ttlTimer = setTimeout(() => {
      this._ttlTimer = null;
      if (this.isRunning()) {
        this.stop().catch(() => { /* best-effort */ });
      }
    }, ms);
    // Unref so a long TTL does not keep the process alive on its own in tests
    if (this._ttlTimer.unref) this._ttlTimer.unref();
  }

  private _clearTtl(): void {
    if (this._ttlTimer !== null) {
      clearTimeout(this._ttlTimer);
      this._ttlTimer = null;
    }
  }

  // ── ITEM 3 process-exit failsafe ──────────────────────────────────────────

  private _registerExitFailsafe(): void {
    if (this._exitHandlerRegistered) return;
    this._exitHandlerRegistered = true;

    // "exit" must be synchronous — use execFileSync to remove adb proxy
    this._exitHandler = () => {
      if (!this.activeConfig) return;
      try {
        const { deviceId } = this.activeConfig;
        execFileSync("adb", ["-s", deviceId, "shell", "settings", "put", "global", "http_proxy", ":0"], {
          stdio: "pipe",
          timeout: 5_000,
        });
      } catch { /* best-effort */ }
    };

    // SIGINT / SIGTERM: run cleanup ONCE, deregister every handler (incl. the
    // "exit" one — otherwise process exit would fire _exitHandler a second time
    // and run the adb cleanup twice), then re-raise default behaviour.
    this._sigintHandler = () => {
      const cleanup = this._exitHandler;
      this._removeExitFailsafe();
      cleanup?.();
      process.kill(process.pid, "SIGINT");
    };
    this._sigtermHandler = () => {
      const cleanup = this._exitHandler;
      this._removeExitFailsafe();
      cleanup?.();
      process.kill(process.pid, "SIGTERM");
    };

    process.once("exit", this._exitHandler);
    process.once("SIGINT", this._sigintHandler);
    process.once("SIGTERM", this._sigtermHandler);
  }

  private _removeExitFailsafe(): void {
    if (!this._exitHandlerRegistered) return;
    if (this._exitHandler) process.removeListener("exit", this._exitHandler);
    if (this._sigintHandler) process.removeListener("SIGINT", this._sigintHandler);
    if (this._sigtermHandler) process.removeListener("SIGTERM", this._sigtermHandler);
    this._exitHandler = null;
    this._sigintHandler = null;
    this._sigtermHandler = null;
    this._exitHandlerRegistered = false;
  }

  // ── Core lifecycle ────────────────────────────────────────────────────────

  async start(config: NetworkMockServiceStartConfig): Promise<NetworkMockStats> {
    // ITEM 4: reject non-Android loudly
    if (config.platform !== "android") {
      throw new Error(
        `network mock is Android-only in v1; iOS (and other platforms) are not supported. ` +
        `Received platform: "${config.platform}".`,
      );
    }

    if (this.server.getPort() > 0) {
      await this.stop();
    }
    const port = await this.server.start(config.rules, "0.0.0.0", config.preferredPort ?? 0);
    const proxyHost = proxyHostForPlatform(config.platform);

    // Install the CA BEFORE mutating the device proxy: if it fails, the device
    // is still untouched, so we can throw without leaving a stuck http_proxy.
    // Stop the (already-listening) server on any failure so it isn't orphaned.
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
      // ITEM 3: register exit failsafe once mock is active
      this._registerExitFailsafe();
      return this.server.getStats();
    } catch (err) {
      try { await this.stop(); } catch { /* best-effort rollback */ }
      throw err;
    }
  }

  async stop(): Promise<NetworkMockStats> {
    // ITEM 3: clear TTL + exit failsafe
    this._clearTtl();
    this._removeExitFailsafe();
    // ITEM 2: clear owner
    this._ownerRunId = null;

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
