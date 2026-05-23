import type { HarmonyNativeAppTarget } from '../task-runners/runHarmonyNativeAppTask.ts'
import { resolveTaskRunnerImportUrl } from './resolveTaskRunnerImport.js'

export interface HarmonyRuntimeTarget {
  deviceId: string
  hdcTconnHost?: string
  hdcTconnPort?: number
  hdcPath?: string
}

function targetToRunnerArgs(target: HarmonyRuntimeTarget): HarmonyNativeAppTarget {
  return {
    deviceId: target.deviceId,
    hdcTconnHost: target.hdcTconnHost,
    hdcTconnPort: target.hdcTconnPort,
    hdcPath: target.hdcPath,
  }
}

/**
 * 鸿蒙任务执行：生成薄层脚本，实际模版见 {@link runHarmonyNativeAppTask}。
 */
export function wrapHarmonyTaskScript(userScript: string, target: HarmonyRuntimeTarget): string {
  const body = userScript.trim()
  const indented = body
    ? body.split(/\r?\n/).map((line) => `      ${line}`).join('\n')
    : '      // （用例脚本为空）'
  const t = targetToRunnerArgs(target)
  const deviceIdLiteral = JSON.stringify(t.deviceId)
  const hostLiteral =
    typeof t.hdcTconnHost === 'string' && t.hdcTconnHost.trim()
      ? JSON.stringify(t.hdcTconnHost.trim())
      : 'undefined'
  const portLiteral =
    Number.isFinite(t.hdcTconnPort) && (t.hdcTconnPort ?? 0) > 0
      ? JSON.stringify(Math.floor(t.hdcTconnPort!))
      : 'undefined'
  const hdcPathLiteral =
    typeof t.hdcPath === 'string' && t.hdcPath.trim() ? JSON.stringify(t.hdcPath.trim()) : 'undefined'
  const runnerImportUrlLiteral = JSON.stringify(resolveTaskRunnerImportUrl('runHarmonyNativeAppTask'))

  return `import { runHarmonyNativeAppTask } from ${runnerImportUrlLiteral};

Promise.resolve(
  runHarmonyNativeAppTask(
    { deviceId: ${deviceIdLiteral}, hdcTconnHost: ${hostLiteral}, hdcTconnPort: ${portLiteral}, hdcPath: ${hdcPathLiteral} },
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
