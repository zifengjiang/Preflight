import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

type ChildStat = {
  absPath: string;
  bytes: number;
  sortKey: number;
};

async function entryRecursiveBytes(absPath: string): Promise<number> {
  const st = await stat(absPath);
  if (st.isFile() || st.isSymbolicLink()) {
    return st.isFile() ? st.size : 0;
  }
  if (!st.isDirectory()) {
    return 0;
  }
  let sum = 0;
  const dirents = await readdir(absPath, { withFileTypes: true });
  for (const d of dirents) {
    const child = path.join(absPath, d.name);
    if (d.isDirectory()) {
      sum += await entryRecursiveBytes(child);
    } else if (d.isFile()) {
      try {
        sum += (await stat(child)).size;
      } catch {
        /* 并发删除等 */
      }
    }
  }
  return sum;
}

async function listChildStats(rootResolved: string): Promise<ChildStat[]> {
  let names: string[];
  try {
    names = await readdir(rootResolved);
  } catch {
    return [];
  }
  const out: ChildStat[] = [];
  for (const name of names) {
    const absPath = path.join(rootResolved, name);
    let st;
    try {
      st = await stat(absPath);
    } catch {
      continue;
    }
    const bytes = st.isDirectory() || st.isFile() ? await entryRecursiveBytes(absPath) : 0;
    const birth = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
    const sortKey = Math.min(st.mtimeMs, birth);
    out.push({ absPath, bytes, sortKey });
  }
  return out;
}

function totalBytes(children: ChildStat[]): number {
  return children.reduce((a, c) => a + c.bytes, 0);
}

/**
 * 在单个根目录下，将其**直接子项**视为可删除单元；总占用超过 `maxBytes` 时按 `sortKey`（更偏创建/修改时间中较早者）从小到大删除，直到不超限或无可删项。
 * 不递归挑选「子树内部的单个文件」，避免拆坏 Midscene 报告目录结构。
 */
export async function trimDirectoryToMaxBytes(
  rootDir: string,
  maxBytes: number,
): Promise<{ deletedPaths: string[]; freedBytes: number; finalTotalBytes: number }> {
  const deletedPaths: string[] = [];
  let freedBytes = 0;
  const rootResolved = path.resolve(rootDir);

  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    const children = await listChildStats(rootResolved);
    return { deletedPaths, freedBytes, finalTotalBytes: totalBytes(children) };
  }

  let guard = 0;
  while (guard < 50_000) {
    guard += 1;
    const children = await listChildStats(rootResolved);
    const sum = totalBytes(children);
    if (sum <= maxBytes) {
      return { deletedPaths, freedBytes, finalTotalBytes: sum };
    }
    if (children.length === 0) {
      return { deletedPaths, freedBytes, finalTotalBytes: sum };
    }
    children.sort((a, b) => a.sortKey - b.sortKey || a.absPath.localeCompare(b.absPath));
    const victim = children[0];
    if (!victim) {
      return { deletedPaths, freedBytes, finalTotalBytes: sum };
    }
    try {
      await rm(victim.absPath, { recursive: true, force: true });
      deletedPaths.push(victim.absPath);
      freedBytes += victim.bytes;
    } catch {
      /* 可能正在被写入；下一轮再试 */
    }
  }
  const children = await listChildStats(rootResolved);
  return { deletedPaths, freedBytes, finalTotalBytes: totalBytes(children) };
}

export type DirCapacityWatchdogOptions = {
  roots: string[];
  maxBytes: number;
  intervalMs: number;
  /** 每次 tick 的日志；默认不写 */
  log?: (line: string) => void;
};

/**
 * 定时按容量裁剪多个根目录（各自独立上限均为 `maxBytes`）。
 * @returns `stop` 清除定时器；不会等待进行中的 tick。
 */
export function startDirCapacityWatchdog(options: DirCapacityWatchdogOptions): { stop: () => void } {
  const roots = [...new Set(options.roots.map((r) => path.resolve(r.trim())).filter(Boolean))];
  const maxBytes = Math.floor(options.maxBytes);
  const intervalMs = Math.floor(options.intervalMs);
  const log = options.log;

  const tick = async (): Promise<void> => {
    for (const root of roots) {
      try {
        const r = await trimDirectoryToMaxBytes(root, maxBytes);
        if (r.deletedPaths.length > 0) {
          log?.(
            `[CacheWatchdog] root=${root} 删除 ${r.deletedPaths.length} 项，释放约 ${r.freedBytes} 字节，剩余约 ${r.finalTotalBytes} / ${maxBytes}`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log?.(`[CacheWatchdog] root=${root} 清理失败: ${msg}`);
      }
    }
  };

  const id = setInterval(() => {
    void tick();
  }, intervalMs);
  if (typeof id.unref === "function") {
    id.unref();
  }

  return {
    stop: () => {
      clearInterval(id);
    },
  };
}

/** 解析如 `1073741824`、`512m`、`2G`（二进制前缀）为正整数字节；无法解析时返回 0 */
export function parsePositiveByteCount(raw: string | undefined): number {
  if (raw == null) return 0;
  const compact = raw.trim().replace(/\s+/g, "");
  if (!compact) return 0;
  const m = /^(\d+(?:\.\d+)?)([kmgt])?b?$/i.exec(compact);
  if (!m) {
    const n = Number(compact);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  const base = Number(m[1]);
  if (!Number.isFinite(base) || base <= 0) return 0;
  const u = (m[2] ?? "").toLowerCase();
  const mul = u === "k" ? 1024 : u === "m" ? 1024 ** 2 : u === "g" ? 1024 ** 3 : u === "t" ? 1024 ** 4 : 1;
  return Math.floor(base * mul);
}
