import { createMidsceneSession } from '../midscene-device-session.ts'
import { MIDSCENE_DEFAULT_REPORT_STEM } from '../midsceneReportConstants.ts'
import type { IosTaskRunnerContext } from './context/iosTaskRunnerContext.ts'
import { createTaskAppPackageFromEnv } from './taskAppPackage.ts'


export type IosNativeAppTarget = {
  wdaHost: string
  wdaPort: number
  deviceId?: string
}

/**
 * 青桔 iOS 原生 App 任务：建连、按关联应用解析的 Bundle 启动 App，再执行用例业务回调。
 * 模版逻辑集中在此文件，便于维护；wrapIosTaskScript 只负责拼接入参与生成的用例片段。
 */
export async function runIosNativeAppTask(
  target: IosNativeAppTarget,
  runBusiness: (ctx: IosTaskRunnerContext) => Promise<void>,
): Promise<void> {
  const sleep: IosTaskRunnerContext['sleep'] = (ms) => new Promise((r) => setTimeout(r, ms))

  const stem = process.env.MIDSCENE_FLOW_REPORT_STEM?.trim() || `ios-${MIDSCENE_DEFAULT_REPORT_STEM}`
  const outputFormat =
    process.env.MIDSCENE_OUTPUT_FORMAT === 'html-and-external-assets' ? 'html-and-external-assets' : 'single-html'
  const session = await createMidsceneSession({
    platform: 'ios',
    wdaHost: target.wdaHost,
    wdaPort: target.wdaPort,
    deviceId: target.deviceId,
    reportFileName: stem,
    outputFormat,
  })
  if (session.platform !== 'ios') {
    throw new Error('当前任务平台不是 iOS')
  }
  const page = session.device
  const agent = session.agent

  console.log(
    '[ios-target]',
    session.target.wdaHost + ':' + session.target.wdaPort,
    session.target.deviceId ? 'udid=' + session.target.deviceId : 'udid=<auto>',
  )

  const { installApp, uninstallApp } = createTaskAppPackageFromEnv()
  await runBusiness({ agent, page, sleep, installApp, uninstallApp }).finally(async () => {
    await page.destroy()
  });
}
