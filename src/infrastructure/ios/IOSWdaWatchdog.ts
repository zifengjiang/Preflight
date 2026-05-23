import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { parseBootedSimulators, parseIOSDevices } from "../adapters/ios/IOSResourceAdapter.js";
import type { CommandRunner } from "../system/CommandRunner.js";

interface WdaPortMapState {
  version: number;
  updatedAt: string;
  portsByUdid: Record<string, number>;
}

export interface IOSWdaWatchdogOptions {
  discoveryCommand: string;
  startCommandTemplate: string;
  stopCommand: string;
  intervalMs: number;
  startupTimeoutMs: number;
  portRangeStart: number;
  portRangeEnd: number;
  stateFilePath: string;
}

function extractDeviceId(resourceLike: string): string {
  const idx = resourceLike.indexOf(":");
  return idx >= 0 ? resourceLike.slice(idx + 1) : resourceLike;
}

function normalizePortRange(startRaw: number, endRaw: number): { start: number; end: number } {
  const fallbackStart = 8200;
  const fallbackEnd = 8399;
  const start = Number.isFinite(startRaw) && startRaw > 0 ? Math.floor(startRaw) : fallbackStart;
  const end = Number.isFinite(endRaw) && endRaw > 0 ? Math.floor(endRaw) : fallbackEnd;
  return start <= end ? { start, end } : { start: end, end: start };
}

function renderTemplate(template: string, udid: string, wdaPort: number): string {
  return template
    .replaceAll("{resourceId}", `ios:${udid}`)
    .replaceAll("{deviceId}", extractDeviceId(udid))
    .replaceAll("{wdaPort}", String(wdaPort));
}

export class IOSWdaWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private pollInFlight: Promise<void> | null = null;
  private running = false;
  private stopped = false;
  private pollCount = 0;
  private readonly portsByUdid = new Map<string, number>();

  constructor(
    private readonly commandRunner: CommandRunner,
    private readonly options: IOSWdaWatchdogOptions,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    console.info(
      `[IOSWdaWatchdog] start intervalMs=${this.options.intervalMs} portRange=${this.options.portRangeStart}-${this.options.portRangeEnd} stateFile=${this.options.stateFilePath}`,
    );
    await this.loadPortMapState();
    await this.pollOnce();
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.options.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (!this.running || this.stopped) return;
    console.info("[IOSWdaWatchdog] stopping");
    this.stopped = true;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      if (this.pollInFlight) {
        await this.pollInFlight;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[IOSWdaWatchdog] pending poll failed while stopping: ${message}`);
    }
    const stopResult = await this.commandRunner.run(this.options.stopCommand, Math.max(5_000, this.options.startupTimeoutMs));
    if (!stopResult.ok) {
      const stderr = stopResult.stderr.trim();
      console.warn(`[IOSWdaWatchdog] stop command failed: ${stderr || "unknown error"}`);
      return;
    }
    console.info("[IOSWdaWatchdog] stop command finished");
  }

  private async pollOnce(): Promise<void> {
    if (!this.running || this.stopped) return;
    if (this.pollInFlight) return this.pollInFlight;
    this.pollInFlight = this.doPoll();
    try {
      await this.pollInFlight;
    } finally {
      this.pollInFlight = null;
    }
  }

  private async doPoll(): Promise<void> {
    const pollId = ++this.pollCount;
    const startedAt = Date.now();
    console.info(`[IOSWdaWatchdog] poll#${pollId} start`);
    const onlineUdids: string[] = [];

    // 1) Real iOS devices via xctrace
    const discovered = await this.commandRunner.run(this.options.discoveryCommand, 15_000);
    if (!discovered.ok) {
      const stderr = discovered.stderr.trim();
      console.warn(`[IOSWdaWatchdog] poll#${pollId} discovery command failed: ${stderr || "unknown error"}`);
    } else {
      const onlineDevices = parseIOSDevices(discovered.stdout);
      onlineUdids.push(...onlineDevices.map((item) => item.udid));
    }

    // 2) Booted simulators via simctl
    const simctlResult = await this.commandRunner.run("xcrun simctl list devices booted", 10_000);
    if (simctlResult.ok) {
      const simDevices = parseBootedSimulators(simctlResult.stdout);
      onlineUdids.push(...simDevices.map((item) => item.udid));
    }

    const uniqueUdids = [...new Set(onlineUdids)];
    console.info(`[IOSWdaWatchdog] poll#${pollId} onlineDevices=${uniqueUdids.length}`);
    const nextPortsByUdid = new Map<string, number>();
    const usedPorts = new Set<number>();
    const devicePlans: Array<{ udid: string; wdaPort: number }> = [];

    if (uniqueUdids.length === 0) {
      console.info(`[IOSWdaWatchdog] poll#${pollId} no online iOS devices`);
    }

    for (const udid of uniqueUdids) {
      try {
        const wdaPort = await this.resolvePortForDevice(udid, usedPorts);
        // Reserve port immediately to avoid assigning the same port in this poll.
        usedPorts.add(wdaPort);
        devicePlans.push({ udid, wdaPort });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[IOSWdaWatchdog] poll#${pollId} skip udid=${udid} reason=${message}`);
      }
    }

    await Promise.all(
      devicePlans.map(async ({ udid, wdaPort }) => {
        console.info(`[IOSWdaWatchdog] poll#${pollId} keepalive udid=${udid} port=${wdaPort}`);
        const startCommand = renderTemplate(this.options.startCommandTemplate, udid, wdaPort);
        const startResult = await this.commandRunner.run(startCommand, this.options.startupTimeoutMs);
        if (!startResult.ok) {
          const stderr = startResult.stderr.trim();
          const stdout = startResult.stdout.trim();
          const looksLikeInteractivePrompt = /password\s*:/i.test(`${stdout}\n${stderr}`);
          if (looksLikeInteractivePrompt) {
            console.warn(
              `[IOSWdaWatchdog] poll#${pollId} start blocked by interactive prompt udid=${udid} port=${wdaPort} (Password prompt detected)`,
            );
          }
          console.warn(
            `[IOSWdaWatchdog] poll#${pollId} start failed udid=${udid} port=${wdaPort} exitCode=${startResult.exitCode} err=${stderr.slice(0, 300)}`,
          );
          return;
        }
        nextPortsByUdid.set(udid, wdaPort);
        console.info(`[IOSWdaWatchdog] poll#${pollId} keepalive ok udid=${udid} port=${wdaPort}`);
      }),
    );

    this.portsByUdid.clear();
    for (const [udid, port] of nextPortsByUdid.entries()) {
      this.portsByUdid.set(udid, port);
    }
    await this.persistPortMapState();
    const durationMs = Date.now() - startedAt;
    console.info(`[IOSWdaWatchdog] poll#${pollId} done kept=${nextPortsByUdid.size} durationMs=${durationMs}`);
  }

  private async resolvePortForDevice(udid: string, usedPorts: Set<number>): Promise<number> {
    const { start, end } = normalizePortRange(this.options.portRangeStart, this.options.portRangeEnd);
    const existing = this.portsByUdid.get(udid);
    if (existing != null && existing >= start && existing <= end && !usedPorts.has(existing)) {
      return existing;
    }
    for (let port = start; port <= end; port += 1) {
      if (usedPorts.has(port)) continue;
      if (!(await this.canBindPort(port))) continue;
      return port;
    }
    throw new Error(`[IOSWdaWatchdog] no available WDA port in range ${start}-${end}`);
  }

  private async canBindPort(port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.unref();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve(true));
      });
    });
  }

  private async loadPortMapState(): Promise<void> {
    try {
      const raw = await readFile(this.options.stateFilePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<WdaPortMapState>;
      const portsByUdid = parsed.portsByUdid;
      if (!portsByUdid || typeof portsByUdid !== "object") return;
      this.portsByUdid.clear();
      for (const [udid, value] of Object.entries(portsByUdid)) {
        const port = Number(value);
        if (!Number.isFinite(port) || port <= 0) continue;
        this.portsByUdid.set(udid, Math.floor(port));
      }
    } catch {
      // Ignore missing or malformed state file, will rebuild on next poll.
    }
  }

  private async persistPortMapState(): Promise<void> {
    const payload: WdaPortMapState = {
      version: 1,
      updatedAt: new Date().toISOString(),
      portsByUdid: Object.fromEntries(Array.from(this.portsByUdid.entries()).sort(([a], [b]) => a.localeCompare(b))),
    };
    await mkdir(path.dirname(this.options.stateFilePath), { recursive: true });
    await writeFile(this.options.stateFilePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}
