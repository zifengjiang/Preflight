import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

/**
 * 将目录打成 zip 文件，返回 **临时** zip 路径。调用方负责在合适时机删除整个临时目录或 zip。
 * 依赖系统 `zip` 可执行文件（macOS / 常见 Linux）。
 */
export async function zipDirectoryToFile(bundleDir: string, stem: string): Promise<string | undefined> {
  if (!bundleDir) return undefined;
  const outDir = await mkdtemp(path.join(tmpdir(), "report-zip-"));
  const outZip = path.join(outDir, `${stem}-bundle.zip`);
  try {
    await execFileAsync("zip", ["-q", "-r", outZip, "."], { cwd: bundleDir });
  } catch {
    await rm(outDir, { recursive: true, force: true });
    return undefined;
  }
  return outZip;
}

export async function readFileAsBase64(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  return buf.toString("base64");
}

export async function rmQuiet(target: string): Promise<void> {
  try {
    await rm(target, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
