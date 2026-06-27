import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  parseAndroidForegroundFromDumpsys,
  parseHarmonyForegroundFromShellDump,
} from "../../utils/liveDebugForegroundParse.js";
import type { RunState } from "../types.js";

const pExecFile = promisify(execFile);
type Runner = (cmd: string, args: string[]) => Promise<string>;

const defaultRunner: Runner = async (cmd, args) => {
  const { stdout } = await pExecFile(cmd, args, { timeout: 4000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
};

export async function probeForegroundBundleId(
  params: NonNullable<RunState["streamParams"]>,
  run: Runner = defaultRunner,
): Promise<string | undefined> {
  try {
    if (params.platform === "ANDROID") {
      const args = params.serial
        ? ["-s", params.serial, "shell", "dumpsys", "activity", "activities"]
        : ["shell", "dumpsys", "activity", "activities"];
      const out = await run("adb", args);
      return parseAndroidForegroundFromDumpsys(out)?.bundleId;
    }
    if (params.platform === "HARMONY") {
      const out = await run(params.hdcPath ?? "hdc", ["shell", "aa", "dump", "-l"]);
      return parseHarmonyForegroundFromShellDump(out)?.bundleId;
    }
    // iOS: WDA activeAppInfo
    const url = `http://${params.wdaHost ?? "127.0.0.1"}:${params.wdaPort ?? 8200}/wda/activeAppInfo`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const j = (await res.json()) as { value?: { bundleId?: string } };
    return j.value?.bundleId;
  } catch {
    return undefined;
  }
}
