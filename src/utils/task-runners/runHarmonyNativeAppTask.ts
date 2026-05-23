import { createMidsceneSession } from '../midscene-device-session.ts'
import { MIDSCENE_DEFAULT_REPORT_STEM } from '../midsceneReportConstants.ts'
import type { HarmonyTaskRunnerContext } from './context/harmonyTaskRunnerContext.ts'
import { createTaskAppPackageFromEnv } from './taskAppPackage.ts'


export type HarmonyNativeAppTarget = {
  deviceId: string
  hdcTconnHost?: string
  hdcTconnPort?: number
  hdcPath?: string
}

/**
 * 青桔鸿蒙原生 App 任务：远程时通过 bridge 注入 `hdc -s`，再建连并执行业务回调。
 */
export async function runHarmonyNativeAppTask(
  target: HarmonyNativeAppTarget,
  runBusiness: (ctx: HarmonyTaskRunnerContext) => Promise<void>,
): Promise<void> {
  const sleep: HarmonyTaskRunnerContext['sleep'] = (ms) => new Promise((r) => setTimeout(r, ms))

  const stem = process.env.MIDSCENE_FLOW_REPORT_STEM?.trim() || `harmony-${MIDSCENE_DEFAULT_REPORT_STEM}`
  const outputFormat =
    process.env.MIDSCENE_OUTPUT_FORMAT === 'html-and-external-assets' ? 'html-and-external-assets' : 'single-html'
  const session = await createMidsceneSession({
    platform: 'harmony',
    deviceId: target.deviceId,
    hdcPath: target.hdcPath,
    hdcTconnHost: target.hdcTconnHost,
    hdcTconnPort: target.hdcTconnPort,
    reportFileName: stem,
    outputFormat,
  })
  if (session.platform !== 'harmony') {
    throw new Error('当前任务平台不是鸿蒙')
  }
  const page = session.device
  const agent = session.agent

  const remoteTargetLog =
    typeof target.hdcTconnHost === 'string' &&
    target.hdcTconnHost.trim() &&
    Number.isFinite(target.hdcTconnPort) &&
    (target.hdcTconnPort ?? 0) > 0
      ? `${target.hdcTconnHost}:${target.hdcTconnPort}`
      : 'local-hdc'
  console.log('[harmony-target]', remoteTargetLog, 'deviceId=' + target.deviceId)



  const { installApp, uninstallApp } = createTaskAppPackageFromEnv()
  await runBusiness({ agent, page, sleep, installApp, uninstallApp }).finally(async () => {
    await page.destroy()
  });
}
