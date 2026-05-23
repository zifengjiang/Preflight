import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { constants as FsConstants } from "node:fs";
import { PlatformType } from "../../shared-kernel/enums/index.js";
import type { ResolvedLocalPackage } from "../../utils/appPackageLocalPath.js";

const INDEX_NAME = "url-cache-index.json";
const CACHE_SUBDIR = "url-cache";

function isProbablyHttpUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref.trim());
}

function normalizePackageUrl(raw: string): string {
  const u = new URL(raw.trim());
  u.hash = "";
  return u.toString();
}

function urlCacheKey(normalizedUrl: string, platform: PlatformType): string {
  return createHash("sha256").update(`${normalizedUrl}\n${platform}`, "utf8").digest("hex");
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

function guessExtensionFromUrl(sourceUrl: string, platform: PlatformType): string {
  try {
    const u = new URL(sourceUrl);
    const base = u.pathname.split("/").pop() ?? "";
    const m = /\.(apk|ipa|hap)$/i.exec(base);
    if (m) return m[0].toLowerCase();
  } catch {
    /* ignore */
  }
  return extensionForPlatform(platform);
}

export type AppPackageCacheItem = {
  url: string;
  platform: PlatformType;
  localPath: string;
  byteSize: number;
  downloadedAt: string;
};

type IndexEntryV1 = {
  url: string;
  platform: PlatformType;
  fileName: string;
  byteSize: number;
  downloadedAt: string;
};

type IndexFileV1 = {
  version: 1;
  entries: Record<string, IndexEntryV1>;
};

export type AppPackageUrlCacheOptions = {
  /** 与 AGENT_APP_DOWNLOAD_DIR 一致；未设置时使用系统临时目录下固定子目录 */
  downloadDir?: string;
  agentId: string;
  /** 缓存列表变化时上报（含首次下载、启动加载到非空索引） */
  onChanged?: (payload: { agentId: string; items: AppPackageCacheItem[] }) => void | Promise<void>;
  fetchImpl?: typeof fetch;
};

/**
 * 按 **规范化后的 http(s) 安装链接 + 目标平台** 主键复用本地包：命中则不再下载，直接用于安装；索引持久化在缓存目录。
 */
export class AppPackageUrlCache {
  private readonly cacheDir: string;
  private readonly indexPath: string;
  private readonly agentId: string;
  private readonly onChanged?: AppPackageUrlCacheOptions["onChanged"];
  private readonly fetchImpl: typeof fetch;
  private index: IndexFileV1 = { version: 1, entries: {} };
  private readonly tails = new Map<string, Promise<ResolvedLocalPackage>>();

  constructor(opts: AppPackageUrlCacheOptions) {
    this.agentId = opts.agentId;
    this.onChanged = opts.onChanged;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    const base = (opts.downloadDir?.trim() || path.join(tmpdir(), "agent-app-packages")).replace(/\/+$/, "");
    this.cacheDir = path.join(base, CACHE_SUBDIR);
    this.indexPath = path.join(this.cacheDir, INDEX_NAME);
  }

  getCacheDir(): string {
    return this.cacheDir;
  }

  listItems(): AppPackageCacheItem[] {
    return Object.values(this.index.entries).map((e) => ({
      url: e.url,
      platform: e.platform,
      localPath: path.join(this.cacheDir, e.fileName),
      byteSize: e.byteSize,
      downloadedAt: e.downloadedAt,
    }));
  }

  async bootstrap(): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
    await this.loadIndex();
    const prunedEmitted = await this.pruneMissingFiles();
    if (this.listItems().length > 0 && !prunedEmitted) {
      await this.fireChanged();
    }
  }

  async resolveHttpToLocalPackage(rawUrl: string, platform: PlatformType): Promise<ResolvedLocalPackage> {
    const normalized = normalizePackageUrl(rawUrl.trim());
    const key = urlCacheKey(normalized, platform);
    const prev = this.tails.get(key) ?? Promise.resolve();
    const mine = prev.then(() => this.downloadOrUseCached(normalized, platform, key));
    this.tails.set(key, mine);
    try {
      return await mine;
    } finally {
      if (this.tails.get(key) === mine) {
        this.tails.delete(key);
      }
    }
  }

  private async downloadOrUseCached(
    normalizedUrl: string,
    platform: PlatformType,
    indexKey: string,
  ): Promise<ResolvedLocalPackage> {
    await mkdir(this.cacheDir, { recursive: true });
    await this.loadIndex();

    const existing = this.index.entries[indexKey];
    if (existing) {
      const abs = path.join(this.cacheDir, existing.fileName);
      try {
        await access(abs, FsConstants.R_OK);
        const noop = async (): Promise<void> => {};
        return { localPath: abs, cleanupTemp: noop };
      } catch {
        delete this.index.entries[indexKey];
        await this.saveIndex();
      }
    }

    const ext = guessExtensionFromUrl(normalizedUrl, platform);
    const fileName = `${indexKey}${ext}`;
    const destPart = path.join(this.cacheDir, `${fileName}.part`);
    const destFinal = path.join(this.cacheDir, fileName);

    const res = await this.fetchImpl(normalizedUrl, { redirect: "follow" });
    if (!res.ok) {
      throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(destPart, buf);
    await rename(destPart, destFinal);

    const st = await stat(destFinal);
    const downloadedAt = new Date().toISOString();
    this.index.entries[indexKey] = {
      url: normalizedUrl,
      platform,
      fileName,
      byteSize: st.size,
      downloadedAt,
    };
    await this.saveIndex();
    await this.fireChanged();

    const noop = async (): Promise<void> => {};
    return { localPath: destFinal, cleanupTemp: noop };
  }

  private async loadIndex(): Promise<void> {
    try {
      const raw = await readFile(this.indexPath, "utf8");
      const parsed = JSON.parse(raw) as IndexFileV1;
      if (parsed?.version === 1 && parsed.entries && typeof parsed.entries === "object") {
        this.index = parsed;
      }
    } catch {
      this.index = { version: 1, entries: {} };
    }
  }

  private async saveIndex(): Promise<void> {
    const tmp = `${this.indexPath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.index, null, 2), "utf8");
    await rename(tmp, this.indexPath);
  }

  private async pruneMissingFiles(): Promise<boolean> {
    let changed = false;
    for (const [k, e] of Object.entries(this.index.entries)) {
      const abs = path.join(this.cacheDir, e.fileName);
      try {
        await access(abs, FsConstants.R_OK);
      } catch {
        delete this.index.entries[k];
        changed = true;
      }
    }
    if (changed) {
      await this.saveIndex();
      await this.fireChanged();
      return true;
    }
    return false;
  }

  /** 供 HTTP 查询：从磁盘刷新索引并清理幽灵项 */
  async snapshotForHttp(): Promise<{ agentId: string; items: AppPackageCacheItem[] }> {
    await this.loadIndex();
    await this.pruneMissingFiles();
    return { agentId: this.agentId, items: this.listItems() };
  }

  private async fireChanged(): Promise<void> {
    if (!this.onChanged) return;
    await this.onChanged({ agentId: this.agentId, items: this.listItems() });
  }

  /** 安装入口：http(s) 走缓存，其它仍由调用方用原有 resolve 逻辑 */
  static isHttpRef(appRef: string): boolean {
    return isProbablyHttpUrl(appRef);
  }
}
