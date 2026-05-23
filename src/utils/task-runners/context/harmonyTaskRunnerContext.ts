import type { HarmonyAgent, HarmonyDevice } from '@midscene/harmony'

export type HarmonyTaskRunnerContext = {
  agent: HarmonyAgent
  page: HarmonyDevice
  sleep: (ms: number) => Promise<void>
  installApp: (appRef: string) => Promise<void>
  uninstallApp: (bundleId: string) => Promise<void>
}
