import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function resolveTaskRunnerImportUrl(runnerName: string): string {
  const runtimeRoot = process.env.AGENT_RUNTIME_ROOT?.trim() || process.cwd()
  const distRunner = path.join(runtimeRoot, 'dist/utils/task-runners', `${runnerName}.js`)
  if (existsSync(distRunner)) {
    return pathToFileURL(distRunner).href
  }
  return pathToFileURL(path.join(process.cwd(), 'src/utils/task-runners', `${runnerName}.ts`)).href
}
