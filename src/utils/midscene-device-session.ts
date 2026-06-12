import { execFile, execSync } from 'node:child_process'
import { promisify } from 'node:util'
import {
  hdcListTargetsSimpleLines,
  hdcListTargetsVerboseStdout,
  looksLikeHdcTcpConnectKey,
  pickHarmonyDeviceIdFromList,
  resolveHarmonyDeviceIdFromVerboseList,
  resolveHdcCliExecutable,
} from './harmonyHdcDeviceId.ts'
import { getHarmonyHdcBridgeScriptPath } from './harmonyAgentDebugDevice.ts'
import { AndroidAgent, AndroidDevice } from '@midscene/android'
import { HarmonyAgent, HarmonyDevice, getConnectedDevices as getHarmonyDevices } from '@midscene/harmony'
import { IOSAgent, IOSDevice } from '@midscene/ios'

import { midsceneTaskCacheFromEnv } from './midscene-task-cache-env.ts'

const execFileAsync = promisify(execFile)

const REPLAN_CYCLE_LIMIT = 40
const WAIT_AFTER_ACTION = 2000
type DeviceRow = {
  serial: string
  state: string
}

type BaseSessionOptions = {
  aiActContext?: string
  /** 与 @midscene/core ReportGenerator 一致，默认单文件 HTML。 */
  outputFormat?: 'single-html' | 'html-and-external-assets'
}

export type IosSessionOptions = BaseSessionOptions & {
  platform: 'ios'
  deviceId?: string
  wdaHost?: string
  wdaPort?: number | string
  reportFileName?: string
}

export type AndroidSessionOptions = BaseSessionOptions & {
  platform: 'android'
  serial?: string
  adbHost?: string
  adbPort?: number | string
  /** 不含后缀；库内会拼成 report.html，见 MIDSCENE_REPORT_FILE_STEM */
  reportFileName?: string
}

export type HarmonySessionOptions = BaseSessionOptions & {
  platform: 'harmony'
  deviceId?: string
  hdcPath?: string
  /** 不含后缀；库内会拼成 report.html，见 MIDSCENE_REPORT_FILE_STEM */
  reportFileName?: string
  /** 与设备管理一致：远程时使用 `hdc -s host:port`（字段名沿用 hdcTconn*） */
  hdcTconnHost?: string
  hdcTconnPort?: number
}

export type MidsceneSessionOptions =
  | IosSessionOptions
  | AndroidSessionOptions
  | HarmonySessionOptions

export type IosSession = {
  platform: 'ios'
  device: IOSDevice
  agent: IOSAgent
  target: {
    deviceId?: string
    wdaHost: string
    wdaPort: number
  }
}

export type AndroidSession = {
  platform: 'android'
  device: AndroidDevice
  agent: AndroidAgent
  target: {
    serial: string
    adbHost: string
    adbPort: number
  }
}

export type HarmonySession = {
  platform: 'harmony'
  device: HarmonyDevice
  agent: HarmonyAgent
  target: {
    deviceId: string
    hdcPath?: string
  }
}

export type MidsceneSession = IosSession | AndroidSession | HarmonySession

const DEFAULT_AI_CONTEXT = '若出现权限、协议或系统弹窗请点击同意或允许；若出现登录页可关闭。'
const MIDSCENE_EVENT_PREFIX = '__MIDSCENE_EVENT__'

type MidsceneAgentLike = {
  onTaskStartTip?: (tip: string) => void | Promise<void>
  addDumpUpdateListener?: (
    listener: (dump: string, executionDump?: MidsceneExecutionDumpLike) => void,
  ) => () => void
}

type MidsceneUsageLike = {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  cached_input?: number
  time_cost?: number
  model_name?: string
  model_description?: string
}

type MidsceneExecutionTaskLike = {
  flowStepIndex?: number
  timing?: { cost?: number }
  usage?: MidsceneUsageLike
  log?: { taskInfo?: { durationMs?: number; usage?: MidsceneUsageLike; searchAreaUsage?: MidsceneUsageLike } }
}

function flowStepIndexFromEnv(): number | undefined {
  const raw =
    typeof process.env.MIDSCENE_FLOW_STEP_INDEX === 'string'
      ? process.env.MIDSCENE_FLOW_STEP_INDEX.trim()
      : ''
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined
}

function flowStepIndexFromDumpTasks(tasks: MidsceneExecutionTaskLike[]): number | undefined {
  for (const t of tasks) {
    const q = (t as { flowStepIndex?: unknown }).flowStepIndex
    if (typeof q === 'number' && Number.isFinite(q) && q >= 1) return Math.floor(q)
    if (typeof q === 'string') {
      const n = Number.parseInt(q.trim(), 10)
      if (Number.isFinite(n) && n >= 1) return n
    }
  }
  return undefined
}

type MidsceneExecutionDumpLike = {
  name?: string
  description?: string
  tasks?: MidsceneExecutionTaskLike[]
}

type MidsceneUsageSummary = {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cached_input: number
  model_name?: string
  model_description?: string
  durationMs?: number
  callCount: number
}

function emitMidsceneEvent(payload: Record<string, unknown>): void {
  try {
    console.log(`${MIDSCENE_EVENT_PREFIX}${JSON.stringify(payload)}`)
  } catch {
    /* ignore */
  }
}

function finiteNumber(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/**
 * Apply MIDSCENE_FLOW_STEP_INDEX from the current environment to each task in
 * the Midscene execution dump, so _merged.dump.json can align screenshots with
 * flow steps.
 */
function applyFlowStepIndexToDumpTasks(tasks: unknown[]): void {
  const raw =
    typeof process.env.MIDSCENE_FLOW_STEP_INDEX === 'string' ? process.env.MIDSCENE_FLOW_STEP_INDEX.trim() : ''
  const stepIndex = raw ? Number.parseInt(raw, 10) : Number.NaN
  if (!Number.isFinite(stepIndex) || stepIndex < 1) return
  for (const t of tasks) {
    if (t && typeof t === 'object' && !Object.prototype.hasOwnProperty.call(t, 'flowStepIndex')) {
      ;(t as Record<string, unknown>).flowStepIndex = stepIndex
    }
  }
}

function summarizeExecutionUsage(tasks: MidsceneExecutionTaskLike[]): MidsceneUsageSummary | null {
  const summary: MidsceneUsageSummary = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cached_input: 0,
    callCount: 0,
  }
  let durationMs = 0
  let hasDuration = false

  for (const task of tasks) {
    const taskInfo = task.log?.taskInfo
    const usage = task.usage ?? taskInfo?.usage
    if (!usage) continue

    summary.callCount += 1
    summary.prompt_tokens += finiteNumber(usage.prompt_tokens) ?? 0
    summary.completion_tokens += finiteNumber(usage.completion_tokens) ?? 0
    summary.total_tokens += finiteNumber(usage.total_tokens) ?? 0
    summary.cached_input += finiteNumber(usage.cached_input) ?? 0
    const usageDuration = finiteNumber(usage.time_cost)
    const taskInfoDuration = finiteNumber(taskInfo?.durationMs)
    const taskDuration = usageDuration ?? taskInfoDuration
    if (taskDuration != null) {
      durationMs += taskDuration
      hasDuration = true
    }
    if (typeof usage.model_name === 'string' && usage.model_name.trim()) {
      summary.model_name = usage.model_name.trim()
    }
    if (typeof usage.model_description === 'string' && usage.model_description.trim()) {
      summary.model_description = usage.model_description.trim()
    }
  }

  if (summary.callCount <= 0) return null
  if (summary.total_tokens <= 0) {
    summary.total_tokens = summary.prompt_tokens + summary.completion_tokens
  }
  if (hasDuration) summary.durationMs = durationMs
  return summary
}

function attachMidsceneAgentEventHooks(
  platform: 'ios' | 'android' | 'harmony',
  agent: MidsceneAgentLike,
): void {
  agent.onTaskStartTip = (tip: string) => {
    const text = typeof tip === 'string' ? tip.trim() : ''
    if (!text) return
    emitMidsceneEvent({
      type: 'task-start-tip',
      platform,
      tip: text,
      ts: Date.now(),
    })
  }

  if (typeof agent.addDumpUpdateListener === 'function') {
    let lastName = ''
    let lastMetricKey = ''
    agent.addDumpUpdateListener((_dump, executionDump) => {
      const name = typeof executionDump?.name === 'string' ? executionDump.name.trim() : ''
      const tasks = Array.isArray(executionDump?.tasks) ? executionDump.tasks : []
      applyFlowStepIndexToDumpTasks(tasks as unknown[])
      const usageSummary = summarizeExecutionUsage(tasks)
      const metricKey = JSON.stringify({
        name,
        count: tasks.length,
        callCount: usageSummary?.callCount,
        durationMs: usageSummary?.durationMs,
        promptTokens: usageSummary?.prompt_tokens,
        completionTokens: usageSummary?.completion_tokens,
        totalTokens: usageSummary?.total_tokens,
      })

      if (name && name !== lastName) {
        lastName = name
        emitMidsceneEvent({
          type: 'dump-update',
          platform,
          name,
          ts: Date.now(),
        })
      }

      if (usageSummary && metricKey !== lastMetricKey) {
        lastMetricKey = metricKey
        const flowStepIndex =
          flowStepIndexFromEnv() ??
          flowStepIndexFromDumpTasks(tasks as MidsceneExecutionTaskLike[])
        emitMidsceneEvent({
          type: 'task-usage',
          platform,
          name,
          taskCount: tasks.length,
          aiCallCount: usageSummary.callCount,
          durationMs: usageSummary.durationMs,
          usage: {
            prompt_tokens: usageSummary.prompt_tokens,
            completion_tokens: usageSummary.completion_tokens,
            total_tokens: usageSummary.total_tokens,
            cached_input: usageSummary.cached_input,
            model_name: usageSummary.model_name,
            model_description: usageSummary.model_description,
          },
          ts: Date.now(),
          ...(flowStepIndex != null ? { flowStepIndex } : {}),
        })
      }
    })
  }
}

function toValidPort(port: string | number, name: string): number {
  const parsed = typeof port === 'number' ? port : Number(port)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} 非法: ${String(port)}`)
  }
  return parsed
}

function parseAdbDevices(output: string): DeviceRow[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('List of devices attached'))
    .map((line) => {
      const [serial, state] = line.split(/\s+/)
      return { serial, state }
    })
    .filter((row) => Boolean(row.serial))
}

function getRemoteDevices(adbHost: string, adbPort: number): DeviceRow[] {
  const raw = execSync(`adb -H ${adbHost} -P ${adbPort} devices`, {
    encoding: 'utf8',
  })
  return parseAdbDevices(raw)
}

function chooseAndroidSerial(devices: DeviceRow[], preferredSerial?: string): string {
  if (preferredSerial) {
    const target = devices.find((d) => d.serial === preferredSerial)
    if (!target) {
      throw new Error(`未找到设备: ${preferredSerial}`)
    }
    if (target.state !== 'device') {
      throw new Error(`设备 ${preferredSerial} 不可用，当前状态: ${target.state}`)
    }
    return target.serial
  }

  const firstReady = devices.find((d) => d.state === 'device')
  if (!firstReady) {
    throw new Error('没有可用设备（state=device）')
  }
  return firstReady.serial
}

async function createAndroidSession(opts: AndroidSessionOptions): Promise<AndroidSession> {
  const adbHost = opts.adbHost ?? '127.0.0.1'
  const adbPort = toValidPort(opts.adbPort ?? '5037', 'ADB_PORT')
  const preferredSerial = opts.serial

  const devices = getRemoteDevices(adbHost, adbPort)
  const serial = chooseAndroidSerial(devices, preferredSerial)

  const device = new AndroidDevice(serial, {
    remoteAdbHost: adbHost,
    remoteAdbPort: adbPort,
    scrcpyConfig: {
      enabled: true,
    },
  })
  const taskCache = midsceneTaskCacheFromEnv()
  const agent = new AndroidAgent(device, {
    aiActContext: opts.aiActContext ?? DEFAULT_AI_CONTEXT,
    reportFileName: opts.reportFileName,
    replanningCycleLimit: REPLAN_CYCLE_LIMIT,
    waitAfterAction: WAIT_AFTER_ACTION,
    ...(opts.outputFormat ? { outputFormat: opts.outputFormat } : {}),
    persistExecutionDump: true,
    ...(taskCache ? { cache: taskCache } : {}),
  })
  attachMidsceneAgentEventHooks('android', agent)
  await device.connect()

  return {
    platform: 'android',
    device,
    agent,
    target: {
      serial,
      adbHost,
      adbPort,
    },
  }
}

async function createIosSession(opts: IosSessionOptions): Promise<IosSession> {
  const wdaHost = opts.wdaHost ?? 'localhost'
  const wdaPort = toValidPort(opts.wdaPort ?? '8100', 'WDA_PORT')
  const deviceId = opts.deviceId

  const device = new IOSDevice({
    wdaHost,
    wdaPort,
    ...(deviceId ? { deviceId } : {}),
  })
  const taskCache = midsceneTaskCacheFromEnv()
  const agent = new IOSAgent(device, {
    aiActionContext: opts.aiActContext ?? DEFAULT_AI_CONTEXT,
    reportFileName: opts.reportFileName,
    replanningCycleLimit: REPLAN_CYCLE_LIMIT,
    waitAfterAction: WAIT_AFTER_ACTION,
    ...(opts.outputFormat ? { outputFormat: opts.outputFormat } : {}),
    persistExecutionDump: true,
    ...(taskCache ? { cache: taskCache } : {}),
  })
  attachMidsceneAgentEventHooks('ios', agent)
  console.log(`[ios-target] connecting ${wdaHost}:${wdaPort}${deviceId ? ` udid=${deviceId}` : ' udid=<auto>'}`)
  await device.connect()

  return {
    platform: 'ios',
    device,
    agent,
    target: {
      deviceId,
      wdaHost,
      wdaPort,
    },
  }
}

async function createHarmonySession(opts: HarmonySessionOptions): Promise<HarmonySession> {
  const hdcPath = opts.hdcPath
  let deviceId = opts.deviceId

  const hasRemoteTconn =
    typeof opts.hdcTconnHost === 'string' &&
    opts.hdcTconnHost.trim() &&
    typeof opts.hdcTconnPort === 'number' &&
    Number.isFinite(opts.hdcTconnPort) &&
    opts.hdcTconnPort > 0

  if (hasRemoteTconn) {
    const host = opts.hdcTconnHost!.trim()
    const port = opts.hdcTconnPort!
    const server = { host, port }
    const hdcBin = resolveHdcCliExecutable(hdcPath)

    const remoteLines = await hdcListTargetsSimpleLines(hdcBin, 20000, server)
    let resolved = pickHarmonyDeviceIdFromList(remoteLines, deviceId)
    if (!resolved) {
      const verbose = await hdcListTargetsVerboseStdout(hdcBin, 20000, server)
      resolved = resolveHarmonyDeviceIdFromVerboseList(verbose, host, port, deviceId)
    }
    if (!resolved) {
      throw new Error(
        `鸿蒙：hdc -s ${host}:${port} list targets 未解析到设备序列号。请核对：1) 本机可执行「hdc -s ${host}:${port} list targets」；2) 设备端 TCP 端口与主机「HDC 端口」一致；3) 在设备管理重新探测并选择设备。`,
      )
    }
    deviceId = resolved

    process.env.HDC_S = `${host}:${port}`
    process.env.HDC_REAL = hdcBin
  } else if (!deviceId) {
    const devices = await getHarmonyDevices(hdcPath)
    if (!devices.length) {
      throw new Error('没有可用鸿蒙设备')
    }
    deviceId = devices[0].deviceId
  }

  if (deviceId && looksLikeHdcTcpConnectKey(deviceId)) {
    throw new Error(
      '鸿蒙设备 ID 不能为 ip:port 连接串，请通过设备管理重新探测并选择设备（应保存 hdc 序列号），或配置远程 hdc 连接参数。',
    )
  }

  const realHdc = resolveHdcCliExecutable(hdcPath)
  const hdcPathForMidscene = hasRemoteTconn
    ? getHarmonyHdcBridgeScriptPath()
    : hdcPath
      ? realHdc
      : undefined

  const device = new HarmonyDevice(deviceId, {
    ...(hdcPathForMidscene ? { hdcPath: hdcPathForMidscene } : {}),
  })
  const taskCache = midsceneTaskCacheFromEnv()
  const agent = new HarmonyAgent(device, {
    aiActContext: opts.aiActContext ?? DEFAULT_AI_CONTEXT,
    replanningCycleLimit: REPLAN_CYCLE_LIMIT,
    waitAfterAction: WAIT_AFTER_ACTION,
    ...(opts.reportFileName ? { reportFileName: opts.reportFileName } : {}),
    ...(opts.outputFormat ? { outputFormat: opts.outputFormat } : {}),
    persistExecutionDump: true,
    ...(taskCache ? { cache: taskCache } : {}),
  })
  attachMidsceneAgentEventHooks('harmony', agent)
  await device.connect()

  return {
    platform: 'harmony',
    device,
    agent,
    target: {
      deviceId,
      ...(hdcPathForMidscene ? { hdcPath: hdcPathForMidscene } : {}),
    },
  }
}

export async function createMidsceneSession(opts: MidsceneSessionOptions): Promise<MidsceneSession> {
  if (opts.platform === 'android') return createAndroidSession(opts)
  if (opts.platform === 'ios') return createIosSession(opts)
  return createHarmonySession(opts)
}
