import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * hdc 简单 `list targets` 可能把 TCP 连接键单独成行（如 192.168.1.1:8710），
 * 不能作为 @midscene/harmony 里 HdcClient 的 deviceId（需为序列号等真实 target）。
 */

export function looksLikeHdcTcpConnectKey(id: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(id.trim())
}

/** 与 Midscene 一致：可用完整 hdc 路径或依赖 PATH 上的 `hdc` */
export function resolveHdcCliExecutable(hdcPath?: string): string {
  const p = typeof hdcPath === 'string' ? hdcPath.trim() : ''
  return p || 'hdc'
}

/**
 * 远程设备：与命令行 `hdc -s 172.23.x.x:8710 list targets` 一致（OpenHarmony hdc 会话参数 `-s`）。
 * 不同于仅 `tconn`：部分环境必须用 `-s` 才能列出/操作该 TCP 上的设备。
 */
export function hdcRemoteServerPrefixArgs(host: string, port: number): string[] {
  return ['-s', `${host.trim()}:${port}`]
}

export function parseHdcListTargetsStdout(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('['))
}

export async function hdcListTargetsSimpleLines(
  hdcExecutable = 'hdc',
  timeoutMs = 20000,
  server?: { host: string; port: number },
): Promise<string[]> {
  const tail = ['list', 'targets'] as const
  const argv = server ? [...hdcRemoteServerPrefixArgs(server.host, server.port), ...tail] : [...tail]
  const { stdout } = await execFileAsync(hdcExecutable, argv, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  })
  return parseHdcListTargetsStdout(stdout)
}

export async function hdcListTargetsVerboseStdout(
  hdcExecutable = 'hdc',
  timeoutMs = 20000,
  server?: { host: string; port: number },
): Promise<string> {
  const tail = ['list', 'targets', '-v'] as const
  const argv = server ? [...hdcRemoteServerPrefixArgs(server.host, server.port), ...tail] : [...tail]
  const { stdout } = await execFileAsync(hdcExecutable, argv, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  })
  return stdout
}

/** 远程 `hdc -s ip:port list targets` 下列出的序列号（或本地 list）中选取设备 ID */
export function pickHarmonyDeviceIdFromList(
  lineIds: string[],
  preferredSerial?: string,
): string | null {
  const cleaned = lineIds.map((l) => l.trim()).filter((l) => l.length > 0 && !looksLikeHdcTcpConnectKey(l))
  const pref = preferredSerial?.trim()
  if (pref && !looksLikeHdcTcpConnectKey(pref) && cleaned.includes(pref)) return pref
  if (cleaned.length === 1) return cleaned[0]
  if (cleaned.length > 1 && pref && cleaned.includes(pref)) return pref
  if (cleaned.length > 0) return cleaned[0]
  return null
}

function splitVerboseLines(verboseStdout: string): string[] {
  return verboseStdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('['))
}

/** 部分 hdc 版本在 -v 中不重复打印 IP，仅标 TCP —— 用行内 TCP 标记兜底 */
function collectVerboseFirstColumnFromTcpLines(verboseStdout: string): string[] {
  const lines = splitVerboseLines(verboseStdout)
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of lines) {
    if (!/\bTCP\b/i.test(line)) continue
    const first = line.split(/\t+/)[0]?.trim()
    if (first && !looksLikeHdcTcpConnectKey(first) && !seen.has(first)) {
      seen.add(first)
      out.push(first)
    }
  }
  return out
}

/**
 * 从 `hdc list targets -v` 输出中解析与某次 tconn（host:port）相关的设备序列号。
 */
export function resolveHarmonyDeviceIdFromVerboseList(
  verboseStdout: string,
  hostIp: string,
  hdcPort: number,
  preferredDeviceId?: string,
): string | null {
  const lines = splitVerboseLines(verboseStdout)
  const tcpKey = `${hostIp}:${hdcPort}`

  if (preferredDeviceId && !looksLikeHdcTcpConnectKey(preferredDeviceId)) {
    const pref = preferredDeviceId.trim()
    for (const line of lines) {
      const first = line.split(/\t+/)[0]?.trim()
      if (first === pref) return pref
    }
  }

  for (const line of lines) {
    if (!line.includes(hostIp) && !line.includes(tcpKey)) continue
    const first = line.split(/\t+/)[0]?.trim()
    if (first && !looksLikeHdcTcpConnectKey(first)) return first
  }

  const loose = collectVerboseFirstColumnFromTcpLines(verboseStdout)
  if (loose.length === 1) return loose[0]
  if (preferredDeviceId && !looksLikeHdcTcpConnectKey(preferredDeviceId)) {
    const pref = preferredDeviceId.trim()
    if (loose.includes(pref)) return pref
  }

  return null
}

/** 探测列表：同一主机下可能多台 */
export function listHarmonyDeviceIdsFromVerboseForHost(
  verboseStdout: string,
  hostIp: string,
  hdcPort: number,
): string[] {
  const lines = splitVerboseLines(verboseStdout)
  const tcpKey = `${hostIp}:${hdcPort}`
  const seen = new Set<string>()
  const out: string[] = []

  for (const line of lines) {
    if (!line.includes(hostIp) && !line.includes(tcpKey)) continue
    const first = line.split(/\t+/)[0]?.trim()
    if (first && !looksLikeHdcTcpConnectKey(first) && !seen.has(first)) {
      seen.add(first)
      out.push(first)
    }
  }

  if (out.length > 0) return out

  return collectVerboseFirstColumnFromTcpLines(verboseStdout)
}
