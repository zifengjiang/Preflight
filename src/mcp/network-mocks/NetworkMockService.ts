import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { WireGuardMockServer } from "./WireGuardMockServer.js";
import type { NetworkMockStats } from "./types.js";
import type { NetworkMockRule } from "../visual-flow/types.js";
import { installWireGuardProfile, setWireGuardTunnelState } from "./device-proxy.js";
import { ensureCaInstalled } from "./device-ca.js";

export interface NetworkMockServiceStartConfig {
  rules: NetworkMockRule[];
  /** Android-only in v1; start() still rejects anything else at runtime. */
  platform: "android";
  deviceId: string;
  preferredPort?: number;
  /** Skip root-only CA installation so a real phone can install the PEM manually. */
  caMode?: "auto" | "manual";
  /** Optional LAN address override for the WireGuard endpoint. */
  proxyHost?: string;
  wireguardTunnelName?: string;
}

export interface NetworkMockStartResult extends NetworkMockStats {
  wireguardTunnelName?: string;
  wireguardProfilePath?: string;
  wireguardProfile?: string;
}

// TTL for waitForCompletion:false runs — 30 minutes.
const ABANDONED_RUN_TTL_MS = 30 * 60 * 1000;

export class NetworkMockService {
  private activeServer: WireGuardMockServer | null = null;
  private activeConfig: {
    deviceId: string;
    wireguardTunnelName?: string;
    wireguardStarted?: boolean;
  } | null = null;

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

    // "exit" must be synchronous — close the WireGuard tunnel via adb
    this._exitHandler = () => {
      if (!this.activeConfig) return;
      try {
        const { deviceId, wireguardTunnelName, wireguardStarted } = this.activeConfig;
        if (wireguardStarted && wireguardTunnelName) setWireGuardTunnelState(deviceId, "down", wireguardTunnelName);
      } catch { /* best-effort */ }
    };

    // SIGINT / SIGTERM: run cleanup ONCE, deregister every handler (incl. the
    // "exit" one — otherwise process exit would fire _exitHandler a second time
    // and run the tunnel cleanup twice), then re-raise default behaviour.
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

  async start(config: NetworkMockServiceStartConfig): Promise<NetworkMockStartResult> {
    // ITEM 4: reject non-Android loudly
    if (config.platform !== "android") {
      throw new Error(
        `network mock is Android-only in v1; iOS (and other platforms) are not supported. ` +
        `Received platform: "${config.platform}".`,
      );
    }

    if (this.activeServer?.getPort()) {
      await this.stop();
    }
    if (config.rules.some((rule) => rule.handler)) {
      throw new Error("WireGuard transport currently supports static responses only; handler rules are not supported");
    }
    const proxyHost = config.proxyHost ?? hostAddressForWireGuard();
    const server = new WireGuardMockServer();
    this.activeServer = server;
    try {
      await server.start(config.rules, config.preferredPort ?? 0);
    } catch (err) {
      this.activeServer = null;
      throw err;
    }
    const wireguardTunnelName = config.wireguardTunnelName ?? "preflight-mock";
    let wireguardProfilePath: string | undefined;
    let wireguardProfile: string | undefined;

    // Install the CA BEFORE mutating the device proxy in auto mode. Manual mode
    // is for production phones: get_root_ca_cert() exposes the PEM for the user
    // to install in Android Settings.
    try {
      if ((config.caMode ?? "auto") === "auto") {
        const result = await ensureCaInstalled({
          serial: config.deviceId,
          caPemPath: server.getRootCaPemPath(),
        });
        if (!result.installed) {
          throw new Error(
            `CA install failed on ${config.deviceId} — the device likely needs a rootable (non-Play-Store) Android image (adb root must succeed), or the cert push was denied.` +
            (result.reason ? ` (${result.reason})` : ""),
          );
        }
      }
    } catch (err) {
      try { await server.stop(); } catch { /* best-effort */ }
      this.activeServer = null;
      throw err;
    }

    // From here on the device gets mutated; if anything throws, roll back so we
    // never leave the WireGuard tunnel up or the server listening.
    try {
      this.activeConfig = {
        deviceId: config.deviceId,
        wireguardTunnelName,
      };
      const profileDir = join(process.env.PREFLIGHT_HOME?.trim() || join(homedir(), ".preflight"), "network-mock-wireguard");
      wireguardProfilePath = join(profileDir, `${wireguardTunnelName}.conf`);
      wireguardProfile = server.getClientConfig(proxyHost, wireguardTunnelName);
      const fs = await import("node:fs/promises");
      await fs.mkdir(profileDir, { recursive: true });
      await fs.writeFile(wireguardProfilePath, wireguardProfile, { mode: 0o600 });
      installWireGuardProfile(config.deviceId, wireguardProfilePath, `/sdcard/Download/${wireguardTunnelName}.conf`);
      setWireGuardTunnelState(config.deviceId, "up", wireguardTunnelName);
      this.activeConfig.wireguardStarted = true;
      // ITEM 3: register exit failsafe once mock is active
      this._registerExitFailsafe();
      return {
        ...server.getStats(),
        wireguardTunnelName,
        wireguardProfilePath,
        wireguardProfile,
      };
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
      if (this.activeConfig.wireguardStarted && this.activeConfig.wireguardTunnelName) {
        try { setWireGuardTunnelState(this.activeConfig.deviceId, "down", this.activeConfig.wireguardTunnelName); } catch { /* best-effort cleanup */ }
      }
      this.activeConfig = null;
    }
    if (this.activeServer) await this.activeServer.stop();
    this.activeServer = null;
    return { running: false, port: 0, mitmEnabled: false, rules: [] };
  }

  isRunning(): boolean {
    return (this.activeServer?.getPort() ?? 0) > 0;
  }

  getStats(): NetworkMockStats {
    return this.activeServer?.getStats() ?? { running: false, port: 0, mitmEnabled: false, rules: [] };
  }

  updateRules(rules: NetworkMockRule[]): void {
    this.activeServer?.updateRules(rules);
  }

  getRootCACert(): string | null {
    return this.activeServer?.getRootCACert() ?? null;
  }

  setRecording(enabled: boolean): void { this.activeServer?.setRecording(enabled); }
  isRecording(): boolean { return this.activeServer?.isRecording() ?? false; }
  getRecordedCount(): number { return this.activeServer?.getRecordedCount() ?? 0; }
  exportRecordedRules(): import("../visual-flow/types.js").NetworkMockRule[] {
    return this.activeServer?.exportRecordedRules() ?? [];
  }
}

function hostAddressForWireGuard(): string {
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) return entry.address;
    }
  }
  throw new Error("cannot determine a host LAN address for WireGuard; pass proxyHost explicitly");
}
