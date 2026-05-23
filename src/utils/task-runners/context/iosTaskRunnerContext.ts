import type { IOSAgent, IOSDevice } from '@midscene/ios'

/** iOS 任务 runner 注入给用例脚本的上下文（与 markdown 文档中的 agent / page / sleep 一致） */
export type IosTaskRunnerContext = {
  agent: IOSAgent
  page: IOSDevice
  sleep: (ms: number) => Promise<void>
  installApp: (appRef: string) => Promise<void>
  uninstallApp: (bundleId: string) => Promise<void>
}
