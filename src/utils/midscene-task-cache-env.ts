import type { Cache } from '@midscene/core'

const VALID_STRATEGY = new Set(['read-only', 'read-write', 'write-only'])

/**
 * 从子进程环境组装 Midscene `AgentOpt.cache`。
 * 仅当 `MIDSCENE_TASK_CACHE_ID` 非空时启用；策略非法时回退 `read-write`。
 */
export function midsceneTaskCacheFromEnv(): Cache | undefined {
  const rawId =
    typeof process.env.MIDSCENE_TASK_CACHE_ID === 'string' ? process.env.MIDSCENE_TASK_CACHE_ID.trim() : ''
  if (!rawId) return undefined

  const rawStrat =
    typeof process.env.MIDSCENE_TASK_CACHE_STRATEGY === 'string'
      ? process.env.MIDSCENE_TASK_CACHE_STRATEGY.trim()
      : ''
  const strategy = (
    VALID_STRATEGY.has(rawStrat) ? rawStrat : 'read-write'
  ) as 'read-only' | 'read-write' | 'write-only'
  return { id: rawId, strategy }
}
