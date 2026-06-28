import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

export type Runner = (cmd: string, args: string[]) => Promise<string>;

const defaultRunner: Runner = async (cmd, args) =>
  (await pExecFile(cmd, args, { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 })).stdout.toString();

// After `adb root`, adbd restarts and can take 30-60s to reappear on a slow
// emulator, so wait-for-device needs a much longer timeout than the default.
const waitForDeviceRunner: Runner = async (cmd, args) =>
  (await pExecFile(cmd, args, { timeout: 90_000, maxBuffer: 8 * 1024 * 1024 })).stdout.toString();

export async function computeAndroidHash(caPemPath: string, run: Runner = defaultRunner): Promise<string> {
  return (await run("openssl", ["x509", "-inform", "PEM", "-subject_hash_old", "-noout", "-in", caPemPath])).trim();
}

export async function adbRoot(serial: string, run: Runner = defaultRunner): Promise<void> {
  await run("adb", ["-s", serial, "root"]).catch(() => "");
  // Use the long-timeout runner only for the default path; an injected runner
  // (unit tests) is always honored as-is so the call is still recorded.
  const waitRun = run === defaultRunner ? waitForDeviceRunner : run;
  await waitRun("adb", ["-s", serial, "wait-for-device"]);
}

/**
 * Interpret the stdout of `adb -s <serial> root`.
 *
 * Returns true when adbd confirmed it is (or will be) running as root.
 * Returns false for the production-build refusal ("cannot run as root") and
 * for any unrecognised output — we lean toward false so the doctor note is
 * shown rather than silently suppressed.
 */
export function isRootableAdbOutput(rootStdout: string): boolean {
  if (rootStdout.includes("cannot run as root")) return false;
  if (rootStdout.includes("restarting adbd as root")) return true;
  if (rootStdout.includes("already running as root")) return true;
  // Unknown output → treat as not-confirmed-rootable so the doctor note fires.
  return false;
}

export async function ensureCaInstalled(
  opts: { serial: string; caPemPath: string; mode?: "user" | "system" },
  run: Runner = defaultRunner,
): Promise<{ installed: boolean; already: boolean; store: "user" | "system"; reason?: string }> {
  const hash = await computeAndroidHash(opts.caPemPath, run);
  await adbRoot(opts.serial, run);
  const store = opts.mode ?? "user"; // default per Task 1 spike
  const filename = `${hash}.0`;

  if (store === "user") {
    const target = `/data/misc/user/0/cacerts-added/${filename}`;
    const tmp = `/data/local/tmp/${filename}`;
    const ls = await run("adb", ["-s", opts.serial, "shell", `ls ${target} 2>/dev/null || true`]).catch(() => "");
    if (ls.includes(filename)) return { installed: true, already: true, store };
    await run("adb", ["-s", opts.serial, "push", opts.caPemPath, tmp]);
    await run("adb", ["-s", opts.serial, "shell",
      `mkdir -p /data/misc/user/0/cacerts-added && cp ${tmp} ${target} && chmod 644 ${target} && chown system:system ${target} && restorecon ${target} && rm -f ${tmp}`]);
    const verify = await run("adb", ["-s", opts.serial, "shell", `ls ${target} 2>/dev/null || true`]).catch(() => "");
    const installed = verify.includes(filename);
    return { installed, already: false, store, reason: installed ? undefined : "cert not found in user trust store after push (adb root may have been denied)" };
  }

  // system store (requires emulator booted with -writable-system)
  const sysTarget = `/system/etc/security/cacerts/${filename}`;
  await run("adb", ["-s", opts.serial, "remount"]);
  await run("adb", ["-s", opts.serial, "push", opts.caPemPath, sysTarget]);
  await run("adb", ["-s", opts.serial, "shell", `chmod 644 ${sysTarget}`]);
  const v = await run("adb", ["-s", opts.serial, "shell", `ls ${sysTarget} 2>/dev/null || true`]).catch(() => "");
  const installed = v.includes(filename);
  return { installed, already: false, store: "system", reason: installed ? undefined : "cert not found in system trust store after push (emulator may not be booted with -writable-system)" };
}
