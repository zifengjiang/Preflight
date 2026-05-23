import type { AndroidAgent, AndroidDevice } from '@midscene/android'

export type AndroidTaskRunnerContext = {
  agent: AndroidAgent
  page: AndroidDevice
  sleep: (ms: number) => Promise<void>
  /** 经 Agent HTTP 同步安装；失败抛错（须任务子进程内调用） */
  installApp: (appRef: string) => Promise<void>
  /** 经 Agent HTTP 同步卸载；失败抛错 */
  uninstallApp: (bundleId: string) => Promise<void>
}
