import { mkdirSync, watch, type FSWatcher } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

export type ReportAssetFile = { relativePath: string; base64: string };

export type ExecutionDumpFlushPayload = {
  executionDumpJson: string;
  executionDumpRevision: number;
  reportAssetFiles: ReportAssetFile[];
};

const MAX_ASSETS_PER_FLUSH = 24;
const MAX_ASSET_BYTES_PER_FLUSH = 4 * 1024 * 1024;

export type ReportImageCompressionOptions = {
  quality: number;
  maxWidth?: number;
  overwriteFiles: boolean;
};

function fingerprint(st: { mtimeMs: number; size: number }): string {
  return `${st.mtimeMs}:${st.size}`;
}

export async function mergeExecutionDumpJsonFromDir(bundleDir: string): Promise<Record<string, unknown> | null> {
  const names = await fs.readdir(bundleDir);
  const numbered = names
    .map((name) => {
      const m = /^(\d+)\.execution\.json$/.exec(name);
      return m ? { name, i: Number.parseInt(m[1], 10) } : null;
    })
    .filter((x): x is { name: string; i: number } => x !== null)
    .sort((a, b) => a.i - b.i);

  let base: Record<string, unknown> | null = null;
  const allExecutions: unknown[] = [];
  for (const { name } of numbered) {
    const filePath = path.join(bundleDir, name);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }
    let part: Record<string, unknown>;
    try {
      part = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!base) {
      base = { ...part };
    }
    const ex = part.executions;
    if (Array.isArray(ex)) {
      for (const item of ex) {
        allExecutions.push(item);
      }
    }
  }
  if (!base) {
    return null;
  }
  return { ...base, executions: allExecutions };
}

export function startExecutionDumpWatcher(
  bundleDir: string,
  onFlush: (payload: ExecutionDumpFlushPayload) => void | Promise<void>,
  options?: { debounceMs?: number; imageCompression?: ReportImageCompressionOptions },
): { stop: () => void } {
  try {
    mkdirSync(bundleDir, { recursive: true });
  } catch {
    /* 若仍失败，watch 会抛错由调用方感知 */
  }
  const debounceMs = options?.debounceMs ?? 450;
  let revision = 0;
  const fingerprints = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let watcher: FSWatcher | null = null;
  let lastDumpJsonSent = "";
  const imageCompression = options?.imageCompression;

  const compressImage = async (buf: Buffer, ext: string): Promise<Buffer> => {
    if (!imageCompression || imageCompression.quality >= 100) return buf;
    if (ext === ".gif") return buf;
    let pipeline = sharp(buf, { animated: false }).rotate();
    if (imageCompression.maxWidth && imageCompression.maxWidth > 0) {
      pipeline = pipeline.resize({ width: imageCompression.maxWidth, withoutEnlargement: true });
    }
    const quality = Math.floor(Math.max(1, Math.min(100, imageCompression.quality)));
    if (ext === ".jpg" || ext === ".jpeg") {
      return pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
    }
    if (ext === ".webp") {
      return pipeline.webp({ quality }).toBuffer();
    }
    if (ext === ".png") {
      return pipeline.png({ quality, palette: true, compressionLevel: 9 }).toBuffer();
    }
    return buf;
  };

  const schedule = (): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, debounceMs);
  };

  const flush = async (): Promise<void> => {
    if (stopped) return;
    let merged: Record<string, unknown> | null = null;
    try {
      merged = await mergeExecutionDumpJsonFromDir(bundleDir);
    } catch {
      return;
    }

    const reportAssetFiles: ReportAssetFile[] = [];
    let bytesBudget = MAX_ASSET_BYTES_PER_FLUSH;
    const skipBySize = (size: number, budget: number): boolean => size <= 0 || size > budget;

    const walkImages = async (relBase: string): Promise<void> => {
      const absBase = path.join(bundleDir, relBase);
      let entries;
      try {
        entries = await fs.readdir(absBase, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (reportAssetFiles.length >= MAX_ASSETS_PER_FLUSH) return;
        const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          await walkImages(rel);
          continue;
        }
        if (!ent.isFile()) continue;
        const ext = path.extname(ent.name).toLowerCase();
        if (![".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) continue;
        const full = path.join(bundleDir, rel);
        let st;
        try {
          st = await fs.stat(full);
        } catch {
          continue;
        }
        const fp = fingerprint(st);
        if (fingerprints.get(rel) === fp) continue;
        if (skipBySize(st.size, bytesBudget)) continue;
        let buf: Buffer;
        try {
          buf = await fs.readFile(full);
        } catch {
          continue;
        }
        try {
          const compressed = await compressImage(buf, ext);
          if (compressed.length > 0 && compressed.length < buf.length) {
            buf = compressed;
            if (imageCompression?.overwriteFiles) {
              await fs.writeFile(full, buf);
              st = await fs.stat(full);
            }
          }
        } catch {
          /* 压缩失败时保留原图 */
        }
        bytesBudget -= buf.length;
        fingerprints.set(rel, fingerprint(st));
        reportAssetFiles.push({
          relativePath: rel.replace(/\\/g, "/"),
          base64: buf.toString("base64"),
        });
      }
    };

    try {
      await walkImages("screenshots");
    } catch {
      /* screenshots 可能尚未创建 */
    }

    const jsonStr = merged === null ? "" : JSON.stringify(merged);
    if (reportAssetFiles.length === 0) {
      if (merged === null) return;
      if (jsonStr === lastDumpJsonSent) return;
    }

    revision += 1;
    if (jsonStr) {
      lastDumpJsonSent = jsonStr;
    }

    try {
      await onFlush({
        executionDumpJson: jsonStr || "{}",
        executionDumpRevision: revision,
        reportAssetFiles,
      });
    } catch {
      /* ignore */
    }
  };

  try {
    watcher = watch(bundleDir, { persistent: false, recursive: true }, schedule);
  } catch {
    watcher = watch(bundleDir, { persistent: false }, schedule);
  }
  schedule();

  const stop = (): void => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    watcher?.close();
    watcher = null;
  };
  return { stop };
}
