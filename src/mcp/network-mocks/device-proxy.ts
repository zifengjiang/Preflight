import { execFileSync } from "node:child_process";

/** A runner injectable for tests; defaults to execFileSync (argv array — NO shell). */
export type AdbRunner = (file: string, args: string[]) => void;

const defaultAdbRunner: AdbRunner = (file, args) => {
  execFileSync(file, args, { stdio: "pipe", timeout: 10_000 });
};

export function buildPushWireGuardProfileArgs(deviceId: string, localPath: string, remotePath: string): string[] {
  return ["-s", deviceId, "push", localPath, remotePath];
}

export function buildWireGuardToggleArgs(deviceId: string, action: "up" | "down", tunnelName: string): string[] {
  return [
    "-s", deviceId, "shell", "am", "broadcast",
    "-n", "com.wireguard.android/.model.TunnelManager$IntentReceiver",
    "-a", `com.wireguard.android.action.SET_TUNNEL_${action.toUpperCase()}`,
    "--es", "tunnel", tunnelName,
  ];
}

export function installWireGuardProfile(
  deviceId: string,
  localPath: string,
  remotePath: string,
  run: AdbRunner = defaultAdbRunner,
): void {
  run("adb", buildPushWireGuardProfileArgs(deviceId, localPath, remotePath));
}

export function setWireGuardTunnelState(
  deviceId: string,
  state: "up" | "down",
  tunnelName: string,
  run: AdbRunner = defaultAdbRunner,
): void {
  run("adb", buildWireGuardToggleArgs(deviceId, state, tunnelName));
}
