import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { constants as FsConstants } from "node:fs";
import { PlatformType } from "../shared-kernel/enums/index.js";

function isProbablyHttpUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref.trim());
}

function extensionForPlatform(platform: PlatformType): string {
  switch (platform) {
    case PlatformType.ANDROID:
      return ".apk";
    case PlatformType.IOS:
      return ".ipa";
    case PlatformType.HARMONY:
      return ".hap";
    default:
      return ".pkg";
  }
}

function guessDownloadFilename(sourceUrl: string, platform: PlatformType): string {
  try {
    const u = new URL(sourceUrl);
    const base = u.pathname.split("/").pop() ?? "";
    const m = /\.(apk|ipa|hap)$/i.exec(base);
    if (m) return `download${m[0].toLowerCase()}`;
  } catch {
    /* ignore */
  }
  return `download${extensionForPlatform(platform)}`;
}

async function ensureDownloadParent(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export type ResolvedLocalPackage = {
  localPath: string;
  /** 安装完成后调用以删除临时下载文件（本地路径传入时为 no-op） */
  cleanupTemp: () => Promise<void>;
};

/**
 * - `http(s)://`：下载到临时目录（文件名尽量取自 URL 后缀）
 * - `file:///path`：转为本地路径
 * - 其它：视为本地路径（须已存在）
 */
export async function resolveAppRefToLocalFile(
  appRef: string,
  platform: PlatformType,
  downloadDir?: string,
): Promise<ResolvedLocalPackage> {
  const raw = appRef.trim();
  if (!raw) {
    throw new Error("appRef is empty");
  }

  if (isProbablyHttpUrl(raw)) {
    const parent = (downloadDir?.trim() || tmpdir()).replace(/\/+$/, "");
    await ensureDownloadParent(parent);
    const name = `${Date.now()}-${randomBytes(8).toString("hex")}-${guessDownloadFilename(raw, platform)}`;
    const dest = path.join(parent, name);
    const res = await fetch(raw, { redirect: "follow" });
    if (!res.ok) {
      throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(dest, buf);
    return {
      localPath: dest,
      cleanupTemp: async () => {
        await rm(dest, { force: true });
      },
    };
  }

  const local =
    raw.startsWith("file://") ?
      fileURLToPath(raw)
    : path.resolve(raw);

  await access(local, FsConstants.R_OK);
  return {
    localPath: local,
    cleanupTemp: async () => {},
  };
}
