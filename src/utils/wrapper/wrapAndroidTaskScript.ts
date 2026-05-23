import type { AndroidNativeAppTarget } from '../task-runners/runAndroidNativeAppTask.ts'
import { resolveTaskRunnerImportUrl } from './resolveTaskRunnerImport.js'

export interface AndroidRuntimeTarget {
  adbHost: string
  adbPort: number
  serial?: string
}

function targetToRunnerArgs(target: AndroidRuntimeTarget): AndroidNativeAppTarget {
  return {
    adbHost: target.adbHost,
    adbPort: target.adbPort,
    serial: target.serial,
  }
}

/**
 * Android 任务执行：生成薄层脚本，实际模版见 {@link runAndroidNativeAppTask}。
 */
export function wrapAndroidTaskScript(
  userScript: string,
  target: AndroidRuntimeTarget,
): string {
  const body = userScript.trim()
  const indented = body
    ? body.split(/\r?\n/).map((line) => `      ${line}`).join('\n')
    : '      // （用例脚本为空）'
  const t = targetToRunnerArgs(target)
  const adbHostLiteral = JSON.stringify(t.adbHost)
  const adbPortLiteral = JSON.stringify(t.adbPort)
  const serialLiteral =
    typeof t.serial === 'string' && t.serial.trim()
      ? JSON.stringify(t.serial.trim())
      : 'undefined'
  const runnerImportUrlLiteral = JSON.stringify(resolveTaskRunnerImportUrl('runAndroidNativeAppTask'))

  return `import { runAndroidNativeAppTask } from ${runnerImportUrlLiteral};

Promise.resolve(
  runAndroidNativeAppTask(
    { adbHost: ${adbHostLiteral}, adbPort: ${adbPortLiteral}, serial: ${serialLiteral} },
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
