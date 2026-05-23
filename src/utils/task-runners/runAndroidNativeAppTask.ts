import { createMidsceneSession } from '../midscene-device-session.ts'
import { MIDSCENE_DEFAULT_REPORT_STEM } from '../midsceneReportConstants.ts'
import type { AndroidTaskRunnerContext } from './context/androidTaskRunnerContext.ts'
import { createTaskAppPackageFromEnv } from './taskAppPackage.ts'


export type AndroidNativeAppTarget = {
  adbHost: string
  adbPort: number
  serial?: string
}

/**
 * 青桔 Android 原生 App 任务：建连、启动乘客端，再执行用例业务回调。
 */
export async function runAndroidNativeAppTask(
  target: AndroidNativeAppTarget,
  runBusiness: (ctx: AndroidTaskRunnerContext) => Promise<void>,
): Promise<void> {
  const sleep: AndroidTaskRunnerContext['sleep'] = (ms) => new Promise((r) => setTimeout(r, ms))

  const stem = process.env.MIDSCENE_FLOW_REPORT_STEM?.trim() || `android-${MIDSCENE_DEFAULT_REPORT_STEM}`
  const outputFormat =
    process.env.MIDSCENE_OUTPUT_FORMAT === 'html-and-external-assets' ? 'html-and-external-assets' : 'single-html'
  const session = await createMidsceneSession({
    platform: 'android',
    adbHost: target.adbHost,
    adbPort: target.adbPort,
    serial: target.serial,
    reportFileName: stem,
    outputFormat,
  })
  if (session.platform !== 'android') {
    throw new Error('当前任务平台不是 Android')
  }
  const page = session.device
  const agent = session.agent

  console.log(
    '[android-target]',
    session.target.adbHost + ':' + session.target.adbPort,
    session.target.serial ? 'serial=' + session.target.serial : 'serial=<auto>',
  )

  const { installApp, uninstallApp } = createTaskAppPackageFromEnv()
  await runBusiness({ agent, page, sleep, installApp, uninstallApp }).finally(async () => {
    await page.destroy()
  });

}
