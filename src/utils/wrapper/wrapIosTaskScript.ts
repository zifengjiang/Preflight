import type { IosNativeAppTarget } from '../task-runners/runIosNativeAppTask.ts'
import { resolveTaskRunnerImportUrl } from './resolveTaskRunnerImport.js'

/** WDA 连接信息（`deviceId` 可选） */
export interface IosConnectionTarget {
  wdaHost: string
  wdaPort: number
  deviceId?: string
}

export interface IosRuntimeTarget extends IosConnectionTarget {
}

/**
 * iOS 任务执行：生成薄层脚本，实际模版见 {@link runIosNativeAppTask}（可维护的真实 TS）。
 */
export function wrapIosTaskScript(userScript: string, target: IosRuntimeTarget): string {
  const body = userScript.trim()
  const indented = body
    ? body.split(/\r?\n/).map((line) => `      ${line}`).join('\n')
    : '      // （用例脚本为空）'
  const wdaHostLiteral = JSON.stringify(target.wdaHost)
  const wdaPortLiteral = JSON.stringify(target.wdaPort)
  const deviceIdLiteral =
    typeof target.deviceId === 'string' && target.deviceId.trim()
      ? JSON.stringify(target.deviceId.trim())
      : 'undefined' 
  const runnerImportUrlLiteral = JSON.stringify(resolveTaskRunnerImportUrl('runIosNativeAppTask'))

  return `import { runIosNativeAppTask } from ${runnerImportUrlLiteral};

Promise.resolve(
  runIosNativeAppTask(
    { wdaHost: ${wdaHostLiteral}, wdaPort: ${wdaPortLiteral}, deviceId: ${deviceIdLiteral} },
    async ({ agent, page, sleep, installApp, uninstallApp }) => {
${indented}
    },
  ),
).catch((e) => {
  console.error(e);
  process.exit(1);
});
`
}
