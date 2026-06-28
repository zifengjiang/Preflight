import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

export type Runner = (cmd: string, args: string[]) => Promise<string>;

const defaultRunner: Runner = async (cmd, args) =>
  (await pExecFile(cmd, args, { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 })).stdout.toString();

export async function computeAndroidHash(caPemPath: string, run: Runner = defaultRunner): Promise<string> {
  return (await run("openssl", ["x509", "-inform", "PEM", "-subject_hash_old", "-noout", "-in", caPemPath])).trim();
}

export async function adbRoot(serial: string, run: Runner = defaultRunner): Promise<void> {
  await run("adb", ["-s", serial, "root"]).catch(() => "");
  await run("adb", ["-s", serial, "wait-for-device"]);
}

export async function ensureCaInstalled(
  opts: { serial: string; caPemPath: string; mode?: "user" | "system" },
  run: Runner = defaultRunner,
): Promise<{ installed: boolean; already: boolean; store: "user" | "system" }> {
  const hash = await computeAndroidHash(opts.caPemPath, run);
  await adbRoot(opts.serial, run);
  const store = opts.mode ?? "user"; // default per Task 1 spike

  if (store === "user") {
    const target = `/data/misc/user/0/cacerts-added/${hash}.0`;
    const ls = await run("adb", ["-s", opts.serial, "shell", `ls ${target} 2>/dev/null || true`]).catch(() => "");
    if (ls.includes(hash)) return { installed: true, already: true, store };
    await run("adb", ["-s", opts.serial, "push", opts.caPemPath, `/data/local/tmp/${hash}.0`]);
    await run("adb", ["-s", opts.serial, "shell",
      `mkdir -p /data/misc/user/0/cacerts-added && cp /data/local/tmp/${hash}.0 ${target} && chmod 644 ${target} && chown system:system ${target} && restorecon ${target}`]);
    const verify = await run("adb", ["-s", opts.serial, "shell", `ls ${target} 2>/dev/null || true`]).catch(() => "");
    return { installed: verify.includes(hash), already: false, store };
  }

  // system store (requires emulator booted with -writable-system)
  const sysTarget = `/system/etc/security/cacerts/${hash}.0`;
  await run("adb", ["-s", opts.serial, "remount"]);
  await run("adb", ["-s", opts.serial, "push", opts.caPemPath, sysTarget]);
  await run("adb", ["-s", opts.serial, "shell", `chmod 644 ${sysTarget}`]);
  const v = await run("adb", ["-s", opts.serial, "shell", `ls ${sysTarget} 2>/dev/null || true`]).catch(() => "");
  return { installed: v.includes(hash), already: false, store: "system" };
}
