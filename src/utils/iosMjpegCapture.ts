import http from "node:http";
import https from "node:https";

/** 从已缓冲的字节中截取第一张 JPEG（SOI … EOI） */
export function extractFirstJpegFromBuffer(buf: Buffer): Buffer | null {
  const soi = buf.indexOf(Buffer.from([0xff, 0xd8]));
  if (soi === -1) return null;
  const eoi = buf.indexOf(Buffer.from([0xff, 0xd9]), soi + 2);
  if (eoi === -1) return null;
  return buf.subarray(soi, eoi + 2);
}

function mjpegStreamUrl(wdaHost: string, mjpegPort: number): string {
  const h = wdaHost.trim() || "127.0.0.1";
  const hostForUrl = h.includes(":") && !h.startsWith("[") ? `[${h}]` : h;
  return `http://${hostForUrl}:${mjpegPort}/`;
}

/**
 * 从 WDA MJPEG 服务（默认 9100，与 WebDriver 会话端口独立）读取流直到拼出第一张 JPEG。
 * 不创建 WebDriver 会话，可与 Midscene 任务子进程并行，避免顶掉任务 session。
 */
export async function captureFirstJpegFromWdaMjpegStream(
  wdaHost: string,
  mjpegPort: number,
  options?: { timeoutMs?: number; maxBytes?: number },
): Promise<Buffer> {
  const timeoutMs = options?.timeoutMs ?? 8_000;
  const maxBytes = options?.maxBytes ?? 6 * 1024 * 1024;
  const urlString = mjpegStreamUrl(wdaHost, mjpegPort);
  const u = new URL(urlString);
  const lib = u.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: `${u.pathname}${u.search}` || "/",
        method: "GET",
        headers: { Connection: "close", Accept: "*/*" },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode != null && res.statusCode >= 400) {
          res.resume();
          reject(new Error(`MJPEG HTTP ${res.statusCode}`));
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        let settled = false;

        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          try {
            res.destroy();
          } catch {
            /* ignore */
          }
          fn();
        };

        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          chunks.push(chunk);
          total += chunk.length;
          if (total > maxBytes) {
            settle(() => reject(new Error("MJPEG: exceeded maxBytes before first JPEG")));
            return;
          }
          const buf = Buffer.concat(chunks, total);
          const jpeg = extractFirstJpegFromBuffer(buf);
          if (jpeg) {
            settle(() => resolve(jpeg));
          }
        });

        res.on("end", () => {
          if (settled) return;
          settle(() => reject(new Error("MJPEG: stream ended before first complete JPEG")));
        });

        res.on("error", (err) => {
          settle(() => reject(err instanceof Error ? err : new Error(String(err))));
        });
      },
    );
    req.on("error", (err) => {
      reject(err instanceof Error ? err : new Error(String(err)));
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("MJPEG: request timeout"));
    });
    req.end();
  });
}
