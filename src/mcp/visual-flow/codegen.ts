import type { VisualFlowDocument, VisualStep } from './types.js'
import { tryParseVisualFlow } from './validate.js'

export type LoadedTestCaseForCodegen = {
  id: string
  name: string
  scriptContent?: string
  visualFlow?: unknown | null
}

export type VisualFlowCodegenLoadCase = (id: string) => Promise<LoadedTestCaseForCodegen | null>

export type VisualFlowCodegenContext = {
  /** 当前正在生成脚本的用例 id；用于识别自调用 */
  rootCaseId?: string
  calleeStack: Set<string>
  loadCase: VisualFlowCodegenLoadCase
  /** 父级调用链传下来的脚本入参覆盖，用于递归子脚本声明变量赋值 */
  scriptInputOverrides: Record<string, string>
  tempVarCounter: { n: number }
}

/**
 * 注入到生成脚本顶部；与调试下发的 `MIDSCENE_FLOW_*` 配合。
 */
export const FLOW_STEP_RUNTIME_PRELUDE = `
function __flowStepLog(type: 'start' | 'end' | 'error', stepIndex: number, extra?: Record<string, unknown>): void {
  try {
    console.log('__FLOW_STEP_EVENT__' + JSON.stringify({ type, stepIndex, ts: Date.now(), ...(extra ?? {}) }))
  } catch {
    // ignore logging failures
  }
}

async function __flowStep(
  stepIndex: number,
  fn: () => Promise<void>,
  meta?: { iteration?: number; subtreeSpan?: { min: number; max: number } },
): Promise<void> {
  const mode = String(
    process.env.MIDSCENE_FLOW_EXECUTION_MODE ?? 'full',
  ).toLowerCase()
  const untilRaw = process.env.MIDSCENE_FLOW_UNTIL_STEP ?? ''
  const targetRaw = process.env.MIDSCENE_FLOW_TARGET_STEP ?? ''
  const until = Number.parseInt(untilRaw, 10)
  const target = Number.parseInt(targetRaw, 10)

  const span = meta?.subtreeSpan
  const subtreeContains = (n: number): boolean =>
    span != null &&
    Number.isFinite(span.min) &&
    Number.isFinite(span.max) &&
    Number.isFinite(n) &&
    n >= span.min &&
    n <= span.max

  const shouldRun = (): boolean => {
    if (mode === 'single') {
      if (!Number.isFinite(target)) return false
      if (stepIndex === target) return true
      if (subtreeContains(target)) return true
      return false
    }
    if (mode === 'run_to') return Number.isFinite(until) ? stepIndex <= until : true
    if (mode === 'from_current') {
      if (!Number.isFinite(target)) return false
      if (stepIndex >= target) return true
      if (subtreeContains(target)) return true
      return false
    }
    return true
  }
  if (!shouldRun()) return

  /** 供 Agent midscene-device-session 在 dump 回调里写入各 task 的 flowStepIndex，与编排步骤 100% 对齐 */
  process.env.MIDSCENE_FLOW_STEP_INDEX = String(stepIndex)

  const startedAt = Date.now()
  const iter = meta?.iteration
  const iterExtra = iter != null && Number.isFinite(iter) ? { iteration: iter } : {}
  __flowStepLog('start', stepIndex, iterExtra)
  try {
    await fn()
    __flowStepLog('end', stepIndex, { ...iterExtra, durationMs: Math.max(0, Date.now() - startedAt) })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    __flowStepLog('error', stepIndex, { ...iterExtra, message, durationMs: Math.max(0, Date.now() - startedAt) })
    throw e
  }

  if (mode === 'single' && stepIndex === target) {
    process.exit(0)
  }
  if (mode === 'run_to' && Number.isFinite(until) && stepIndex === until) {
    process.exit(0)
  }
}
const __flowVars = Object.create(null) as Record<string, unknown>

function __flowLogVar(name: string, value: unknown): void {
  try {
    const rendered =
      value == null
        ? String(value)
        : typeof value === 'string'
          ? value
          : JSON.stringify(value)
    console.log('__FLOW_VAR__' + JSON.stringify({ name, value: rendered, ts: Date.now() }))
  } catch {
    console.log('__FLOW_VAR__' + JSON.stringify({ name, value: String(value), ts: Date.now() }))
  }
}

function __flowCutText(source: string, start: string, end: string): string {
  let out = source
  if (start) {
    const idx = out.indexOf(start)
    if (idx >= 0) out = out.slice(idx + start.length)
  }
  if (end) {
    const idx = out.indexOf(end)
    if (idx >= 0) out = out.slice(0, idx)
  }
  return out
}

function __flowJsonPath(source: string, path: string): string {
  if (!path) return source
  try {
    let cur: unknown = JSON.parse(source)
    const parts = path
      .replace(/^\\$\\.?/, '')
      .replace(/\\[(\\d+)\\]/g, '.$1')
      .split('.')
      .map((x) => x.trim())
      .filter(Boolean)
    for (const p of parts) {
      if (cur == null) return ''
      if (Array.isArray(cur)) cur = cur[Number.parseInt(p, 10)]
      else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[p]
      else return ''
    }
    return cur == null ? '' : typeof cur === 'string' ? cur : JSON.stringify(cur)
  } catch {
    return ''
  }
}

function __flowHandleAmount(source: string): string {
  const cleaned = String(source ?? '').replace(/[^\\d.-]+/g, '')
  return cleaned
}
`.trim()

/** @deprecated 使用 {@link FLOW_STEP_RUNTIME_PRELUDE} */
export const DEPRECATED_STEP_RUNTIME_PRELUDE = FLOW_STEP_RUNTIME_PRELUDE

function lit(s: string): string {
  return JSON.stringify(s)
}

export function wrapCalledScriptBlockMarkers(
  title: string,
  scriptId: string,
  scopeId: string,
  body: string,
): string {
  const safeName = title.replace(/\r|\n|\*/g, ' ').trim() || '未命名'
  const content = (body ?? '').replace(/\r\n/g, '\n')
  const lines = [`// --- 调用脚本「${safeName}」 id=${scriptId} scope=${scopeId} ---`]
  if (content.trim()) lines.push(content.trimEnd())
  lines.push(`// --- 结束「${safeName}」 ---`)
  return `\n${lines.join('\n')}\n`
}

/** 读取编排变量；支持 `{{var}}` / `{{var[0]}}` / `{{var.1}}` / `{{var.length}}` */
function emitVarRead(varName: string, index: number | null, useLength = false): string {
  const k = JSON.stringify(varName)
  if (useLength) {
    return `String(Array.isArray(__flowVars[${k}]) ? (__flowVars[${k}] as unknown[]).length : 0)`
  }
  if (index == null) {
    return `String(__flowVars[${k}] ?? '')`
  }
  return `String((Array.isArray(__flowVars[${k}]) ? (__flowVars[${k}] as unknown[])[${index}] : undefined) ?? '')`
}

/**
 * 将 `{{var}}`、`{{var[0]}}`、`{{var.1}}`、`{{var.length}}` 展开为读取 `__flowVars` 的 TS 表达式（与 Midscene 无耦合，仅字符串拼接）。
 */
function emitInterpolatedExpr(s: string): string {
  const re = /\{\{([$_\p{L}][\p{L}\p{N}_$]*)(?:\[(\d+)\]|\.(\d+|length))?\}\}/gu
  if (!re.test(s)) {
    return lit(s)
  }
  re.lastIndex = 0
  const parts: string[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    const stat = s.slice(last, m.index)
    if (stat.length > 0) parts.push(lit(stat))
    const id = m[1]!
    const bracket = m[2]
    const dot = m[3]
    const useLength = dot === 'length'
    const rawIdx =
      bracket != null && bracket !== ''
        ? Number.parseInt(bracket, 10)
        : dot != null && dot !== '' && dot !== 'length'
          ? Number.parseInt(dot, 10)
          : NaN
    const idx: number | null = Number.isFinite(rawIdx) ? rawIdx : null
    parts.push(emitVarRead(id, idx, useLength))
    last = m.index + m[0]!.length
  }
  const tail = s.slice(last)
  if (tail.length > 0) parts.push(lit(tail))
  if (parts.length === 0) return lit('')
  if (parts.length === 1) return parts[0]!
  return `(${parts.join(' + ')})`
}

/** aiQuery 第一个参数：JSON demand 内联为对象/数组字面量，否则为（可插值的）字符串 */
function emitAiQueryDataDemandExpr(expr: string): string {
  const t = expr.trim()
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      const obj = JSON.parse(t) as unknown
      return JSON.stringify(obj)
    } catch {
      /* fall through */
    }
  }
  return emitInterpolatedExpr(expr)
}

/** 按 Midscene `aiQuery<T>(dataDemand: string | object, options?)` 推断常用 T */
function inferAiQueryGeneric(expr: string): string {
  const t = expr.trim()
  if (!t) return ''
  if (t.startsWith('{') && t.endsWith('}')) {
    try {
      JSON.parse(t)
      return '<Record<string, unknown>>'
    } catch {
      return ''
    }
  }
  if (t.startsWith('[') && t.endsWith(']')) {
    try {
      JSON.parse(t)
      return '<unknown[]>'
    } catch {
      return ''
    }
  }
  const first = (t.split(/[,，]/)[0] ?? '').trim().toLowerCase()
  if (first.startsWith('string[]') || first === 'string[]') return '<string[]>'
  if (first.startsWith('string')) return '<string>'
  if (first.startsWith('number')) return '<number>'
  if (first.startsWith('boolean')) return '<boolean>'
  return ''
}

/** 生成 `await agent.aiQuery<…>(dataDemand)`，满足泛型签名 */
function emitAiQueryCall(expr: string): string {
  const inner = emitAiQueryDataDemandExpr(expr)
  const gen = inferAiQueryGeneric(expr)
  return gen ? `await agent.aiQuery${gen}(${inner})` : `await agent.aiQuery(${inner})`
}

function emitRootScriptVars(flow: VisualFlowDocument): string {
  const vars = flow.scriptVars ?? []
  if (!vars.length) return ''
  return vars
    .map((v) => `__flowVars[${JSON.stringify(v.name)}] = __str(${JSON.stringify(v.name)});`)
    .join('\n')
}

function emitCalledFlowScriptVarScope(
  flow: VisualFlowDocument,
  step: Extract<VisualStep, { type: 'callScript' }>,
  ctx: VisualFlowCodegenContext,
  indent: string,
  inner: string,
  inheritedOverrides: Record<string, string>,
): string {
  const vars = flow.scriptVars ?? []
  if (!vars.length) return inner
  const token = `__qsv${++ctx.tempVarCounter.n}`
  const isolatedVars = vars.filter((v) => v.scope !== 'global')
  const isolatedNames = isolatedVars.map((v) => v.name)
  const assigned = vars
    .map((v) => {
      const name = v.name
      const key = JSON.stringify(name)
      const raw = step.varBindings?.[name] ?? inheritedOverrides[name]
      if (raw != null) return `${indent}  __flowVars[${key}] = ${emitInterpolatedExpr(raw)};`
      const fallback = JSON.stringify(v.defaultValue ?? '')
      if (v.scope === 'global') {
        return `${indent}  if (!Object.prototype.hasOwnProperty.call(__flowVars, ${key})) __flowVars[${key}] = ${fallback};`
      }
      return `${indent}  __flowVars[${key}] = ${fallback};`
    })
    .join('\n')
  const restore = isolatedNames
    .map((name) => {
      const key = JSON.stringify(name)
      return `${indent}    if (Object.prototype.hasOwnProperty.call(${token}, ${key})) __flowVars[${key}] = ${token}[${key}]; else delete __flowVars[${key}];`
    })
    .join('\n')
  if (!isolatedNames.length) {
    return `${assigned}\n${inner}`
  }
  return (
    `${indent}{\n` +
    `${indent}  const ${token} = Object.create(null) as Record<string, unknown>;\n` +
    isolatedNames.map((name) => `${indent}  ${token}[${JSON.stringify(name)}] = __flowVars[${JSON.stringify(name)}];`).join('\n') +
    `\n${assigned}\n` +
    `${indent}  try {\n` +
    `${inner}\n` +
    `${indent}  } finally {\n` +
    `${restore}\n` +
    `${indent}  }\n` +
    `${indent}}`
  )
}

function emitLeaf(step: VisualStep, indent: string): string {
  switch (step.type) {
    case 'launch':
      return `${indent}await agent.launch(${emitInterpolatedExpr(step.packageName)});`
    case 'installApp':
      return `${indent}await installApp(${emitInterpolatedExpr(step.appRef)});`
    case 'uninstallApp':
      return `${indent}await uninstallApp(${emitInterpolatedExpr(step.bundleId)});`
    case 'assert':
      return `${indent}await agent.aiAssert(${emitInterpolatedExpr(step.prompt)});`
    case 'sleep':
      return `${indent}await sleep(${step.ms});`
    case 'aiAct':
      return `${indent}await agent.aiAct(${emitInterpolatedExpr(step.prompt)});`
    case 'setAIActContext':
      return `${indent}await agent.setAIActContext(${emitInterpolatedExpr(step.prompt)});`
    case 'recordToReport': {
      const titleT = step.title.trim()
      const contentT = step.content.trim()
      if (!titleT && !contentT) {
        return `${indent}await agent.recordToReport();`
      }
      if (titleT && contentT) {
        return `${indent}await agent.recordToReport(${emitInterpolatedExpr(step.title)}, { content: ${emitInterpolatedExpr(step.content)} });`
      }
      if (titleT) {
        return `${indent}await agent.recordToReport(${emitInterpolatedExpr(step.title)});`
      }
      return `${indent}await agent.recordToReport(undefined, { content: ${emitInterpolatedExpr(step.content)} });`
    }
    case 'assignVar':
      return `${indent}__flowVars[${JSON.stringify(step.name)}] = ${emitInterpolatedExpr(step.value)};`
    case 'transformVar': {
      const key = JSON.stringify(step.name)
      const source = step.source != null ? emitInterpolatedExpr(step.source) : `String(__flowVars[${key}] ?? '')`
      if (step.rule === 'onlyNumber') {
        return `${indent}__flowVars[${key}] = String(${source}).replace(/\\D+/g, '');`
      }
      if (step.rule === 'cut') {
        return `${indent}__flowVars[${key}] = __flowCutText(String(${source}), ${emitInterpolatedExpr(step.start ?? '')}, ${emitInterpolatedExpr(step.end ?? '')});`
      }
      if (step.rule === 'jsonPath') {
        return `${indent}__flowVars[${key}] = __flowJsonPath(String(${source}), ${emitInterpolatedExpr(step.jsonPath ?? '')});`
      }
      if (step.rule === 'replace') {
        return `${indent}__flowVars[${key}] = String(${source}).replace(new RegExp(${emitInterpolatedExpr(step.pattern ?? '')}, 'g'), ${emitInterpolatedExpr(step.replacement ?? '')});`
      }
      return `${indent}__flowVars[${key}] = __flowHandleAmount(String(${source}));`
    }
    case 'closeApp':
      return (
        `${indent}const __pkg = ${emitInterpolatedExpr(step.packageName)};\n` +
        `${indent}if (typeof agent.terminate === 'function') {\n` +
        `${indent}  await agent.terminate(__pkg);\n` +
        `${indent}} else {\n` +
        `${indent}  await agent.runAdbShell(\`am force-stop \${__pkg}\`);\n` +
        `${indent}}`
      )
    case 'if':
    case 'whileLoop':
    case 'forLoop':
    case 'setVar':
    case 'assignVar':
    case 'transformVar':
    case 'callScript':
    case 'ifDeviceType':
      return `${indent}// unexpected compound step`
    default:
      return `${indent}// unexpected leaf`
  }
}

type FlowBodyLoopCtx = { iterationVar: string }

type FlowStepBlockMeta = { iterationVar?: string; subtreeSpan?: { min: number; max: number } }

function mergeFlowStepMeta(
  loopCtx: FlowBodyLoopCtx | undefined,
  subtreeSpan: { min: number; max: number } | undefined,
): FlowStepBlockMeta | undefined {
  const iterationVar = loopCtx?.iterationVar
  const span =
    subtreeSpan && subtreeSpan.min <= subtreeSpan.max ? subtreeSpan : undefined
  if (!iterationVar && !span) return undefined
  return { iterationVar, subtreeSpan: span }
}

function subtreeSpanAfterChildren(boundaryIndex: number, counter: { n: number }): { min: number; max: number } | undefined {
  if (counter.n > boundaryIndex) return { min: boundaryIndex + 1, max: counter.n }
  return undefined
}

function emitFlowStepBlock(
  stepIndex: number,
  indent: string,
  innerBody: string,
  meta?: FlowStepBlockMeta,
): string {
  const parts: string[] = []
  if (meta?.iterationVar) parts.push(`iteration: ${meta.iterationVar}`)
  if (meta?.subtreeSpan && meta.subtreeSpan.min <= meta.subtreeSpan.max) {
    parts.push(`subtreeSpan: { min: ${meta.subtreeSpan.min}, max: ${meta.subtreeSpan.max} }`)
  }
  const metaSuffix = parts.length > 0 ? `, { ${parts.join(', ')} }` : ''
  return `${indent}await __flowStep(${stepIndex}, async () => {\n${innerBody}\n${indent}}${metaSuffix});`
}

async function emitStepsAsync(
  steps: VisualStep[],
  counter: { n: number },
  indent: string,
  ctx: VisualFlowCodegenContext,
  loopCtx?: FlowBodyLoopCtx,
): Promise<string> {
  const lines: string[] = []
  for (const step of steps) {
    if (step.type === 'if') {
      const idx = ++counter.n
      const boundary = counter.n
      const thenBlock = await emitStepsAsync(step.thenSteps, counter, `${indent}    `, ctx, loopCtx)
      const elseBlock =
        step.elseSteps && step.elseSteps.length > 0
          ? await emitStepsAsync(step.elseSteps, counter, `${indent}    `, ctx, loopCtx)
          : ''
      const elseClause =
        elseBlock.trim().length > 0 ? ` else {\n${elseBlock}\n${indent}  }` : ''
      const inner =
        `${indent}  const __c = await agent.aiBoolean(${emitInterpolatedExpr(step.conditionPrompt)});\n` +
        `${indent}  if (__c) {\n` +
        `${thenBlock}\n` +
        `${indent}  }${elseClause}`
      const span = subtreeSpanAfterChildren(boundary, counter)
      lines.push(emitFlowStepBlock(idx, indent, inner, mergeFlowStepMeta(loopCtx, span)))
      continue
    }
    if (step.type === 'ifDeviceType') {
      const idx = ++counter.n
      const boundary = counter.n
      const thenBlock = await emitStepsAsync(step.thenSteps, counter, `${indent}    `, ctx, loopCtx)
      const elseBlock =
        step.elseSteps && step.elseSteps.length > 0
          ? await emitStepsAsync(step.elseSteps, counter, `${indent}    `, ctx, loopCtx)
          : ''
      const elseClause =
        elseBlock.trim().length > 0 ? ` else {\n${elseBlock}\n${indent}  }` : ''
      const want = JSON.stringify(step.interfaceType)
      const inner =
        `${indent}  const __plat = String(agent.interface?.interfaceType ?? '');\n` +
        `${indent}  if (__plat === ${want}) {\n` +
        `${thenBlock}\n` +
        `${indent}  }${elseClause}`
      const span = subtreeSpanAfterChildren(boundary, counter)
      lines.push(emitFlowStepBlock(idx, indent, inner, mergeFlowStepMeta(loopCtx, span)))
      continue
    }
    if (step.type === 'whileLoop') {
      const idx = ++counter.n
      const boundary = counter.n
      const iterVar = `__qi${idx}`
      const bodyBlock = await emitStepsAsync(
        step.bodySteps,
        counter,
        `${indent}    `,
        ctx,
        { iterationVar: iterVar },
      )
      const inner =
        `${indent}  const __maxIter${idx} = ${step.maxIterations};\n` +
        `${indent}  for (let ${iterVar} = 0; ${iterVar} < __maxIter${idx}; ${iterVar}++) {\n` +
        `${indent}    const __cont = await agent.aiBoolean(${emitInterpolatedExpr(step.conditionPrompt)});\n` +
        `${indent}    if (!__cont) break;\n` +
        `${bodyBlock}\n` +
        `${indent}  }`
      const span = subtreeSpanAfterChildren(boundary, counter)
      lines.push(emitFlowStepBlock(idx, indent, inner, mergeFlowStepMeta(loopCtx, span)))
      continue
    }
    if (step.type === 'forLoop') {
      const idx = ++counter.n
      const boundary = counter.n
      const iterVar = `__fi${idx}`
      const bodyBlock = await emitStepsAsync(
        step.bodySteps,
        counter,
        `${indent}    `,
        ctx,
        { iterationVar: iterVar },
      )
      const inner =
        `${indent}  const __cnt${idx} = ${step.count};\n` +
        `${indent}  for (let ${iterVar} = 0; ${iterVar} < __cnt${idx}; ${iterVar}++) {\n` +
        `${bodyBlock}\n` +
        `${indent}  }`
      const span = subtreeSpanAfterChildren(boundary, counter)
      lines.push(emitFlowStepBlock(idx, indent, inner, mergeFlowStepMeta(loopCtx, span)))
      continue
    }
    if (step.type === 'setVar') {
      const idx = ++counter.n
      const keyLit = JSON.stringify(step.name)
      let rhs: string
      if (step.method === 'aiQuery') {
        rhs = emitAiQueryCall(step.expression)
      } else if (step.method === 'aiAsk') {
        rhs = `await agent.aiAsk(${emitInterpolatedExpr(step.expression)})`
      } else if (step.method === 'aiBoolean') {
        rhs = `await agent.aiBoolean(${emitInterpolatedExpr(step.expression)})`
      } else if (step.method === 'aiNumber') {
        rhs = `await agent.aiNumber(${emitInterpolatedExpr(step.expression)})`
      } else {
        rhs = `await agent.aiString(${emitInterpolatedExpr(step.expression)})`
      }
      const inner =
        `${indent}  __flowVars[${keyLit}] = ${rhs};\n` +
        `${indent}  __flowLogVar(${keyLit}, __flowVars[${keyLit}]);`
      lines.push(emitFlowStepBlock(idx, indent, inner, mergeFlowStepMeta(loopCtx, undefined)))
      continue
    }
    if (step.type === 'callScript') {
      const tid = step.targetTestCaseId.trim()
      if (ctx.rootCaseId && tid === ctx.rootCaseId) {
        throw new Error('「调用子脚本」指向了当前脚本自身')
      }
      if (ctx.calleeStack.has(tid)) {
        throw new Error(`子脚本引用形成环: ${[...ctx.calleeStack, tid].join(' → ')}`)
      }
      const loaded = await ctx.loadCase(tid)
      if (!loaded) {
        throw new Error(`子脚本不存在或不可读: ${tid}`)
      }
      const calleeTitle = (step.targetName?.trim() || loaded.name || tid).replace(/\r|\n|\*/g, ' ').trim()
      ctx.calleeStack.add(tid)
      try {
        const vfParsed =
          loaded.visualFlow != null ? tryParseVisualFlow(loaded.visualFlow) : { ok: false as const }
        if (vfParsed.ok) {
          const prevOverrides = ctx.scriptInputOverrides
          ctx.scriptInputOverrides = { ...ctx.scriptInputOverrides, ...(step.varBindings ?? {}) }
          try {
            const inner = await emitStepsAsync(vfParsed.value.steps, counter, `${indent}  `, ctx, loopCtx)
            if (inner.trim().length > 0) {
              lines.push(
                emitCalledFlowScriptVarScope(
                  vfParsed.value,
                  step,
                  ctx,
                  indent,
                  inner,
                  prevOverrides,
                ),
              )
            }
          } finally {
            ctx.scriptInputOverrides = prevOverrides
          }
        } else {
          const raw = (loaded.scriptContent ?? '').trim()
          if (!raw) {
            throw new Error(`子脚本「${calleeTitle}」无编排且无脚本正文`)
          }
          const idx = ++counter.n
          const block = wrapCalledScriptBlockMarkers(calleeTitle, loaded.id, step.scopeId, raw)
          const innerLines = block
            .split('\n')
            .map((ln) => `${indent}  ${ln}`)
            .join('\n')
          lines.push(emitFlowStepBlock(idx, indent, innerLines, mergeFlowStepMeta(loopCtx, undefined)))
        }
      } finally {
        ctx.calleeStack.delete(tid)
      }
      continue
    }
    const idx = ++counter.n
    const body = emitLeaf(step, `${indent}  `)
    lines.push(emitFlowStepBlock(idx, indent, body, mergeFlowStepMeta(loopCtx, undefined)))
  }
  return lines.join('\n')
}

/**
 * 生成可下发 Agent 的业务脚本（假定运行环境已注入 `agent` / `sleep` / `installApp` / `uninstallApp`）。
 * 含 `callScript` 步骤时须提供 `loadCase` 以解析子用例；`rootCaseId` 用于识别自调用。
 */
export async function generateScriptFromVisualFlow(
  flow: VisualFlowDocument,
  opts: { rootCaseId?: string; loadCase: VisualFlowCodegenLoadCase },
): Promise<string> {
  const counter = { n: 0 }
  const ctx: VisualFlowCodegenContext = {
    rootCaseId: opts.rootCaseId,
    calleeStack: new Set(),
    loadCase: opts.loadCase,
    scriptInputOverrides: {},
    tempVarCounter: { n: 0 },
  }
  const scriptVarPrelude = emitRootScriptVars(flow)
  const body = await emitStepsAsync(flow.steps, counter, '', ctx)
  return `${FLOW_STEP_RUNTIME_PRELUDE}${scriptVarPrelude ? `\n${scriptVarPrelude}` : ''}\n\n${body}\n`
}

/** 将脚本变量默认值与各 `callScript` 步骤的 `varBindings` 合并为 `scriptTemplateVars` 片段 */
export function aggregateCallScriptVarBindingsFromFlow(
  flow: VisualFlowDocument,
): Record<string, string | Record<string, string>> {
  const out: Record<string, string | Record<string, string>> = {}
  for (const v of flow.scriptVars ?? []) {
    out[v.name] = v.defaultValue ?? ''
  }
  const walk = (steps: VisualStep[]) => {
    for (const s of steps) {
      if (s.type === 'callScript') {
        const sid = s.scopeId
        const vb = s.varBindings ?? {}
        const prev = out[sid]
        const prevObj = prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {}
        out[sid] = { ...prevObj, ...vb }
      } else if (s.type === 'if' || s.type === 'ifDeviceType') {
        walk(s.thenSteps)
        if (s.elseSteps?.length) walk(s.elseSteps)
      } else if (s.type === 'whileLoop' || s.type === 'forLoop') {
        walk(s.bodySteps)
      }
    }
  }
  walk(flow.steps ?? [])
  return out
}
