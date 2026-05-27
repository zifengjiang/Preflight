import { VISUAL_FLOW_VERSION, type VisualFlowDocument, type VisualFlowScriptVar, type VisualStep, type NetworkMockRule, type NetworkMockResponse } from './types.js'

const SET_VAR_METHODS = new Set(['aiQuery', 'aiAsk', 'aiBoolean', 'aiNumber', 'aiString'])
const TRANSFORM_VAR_RULES = new Set(['onlyNumber', 'cut', 'jsonPath', 'replace', 'handleAmount'])

const RESERVED_SET_VAR_NAMES = new Set([
  '__flowVars',
  '__flowStep',
  '__flowStepLog',
  '__v1Vars',
  '__v1Step',
  '__v1StepLog',
  'process',
  'agent',
  'sleep',
  'installApp',
  'uninstallApp',
  'page',
  'console',
  'Object',
])

function isValidSetVarName(name: string): boolean {
  if (name.length === 0 || name.length > 64) return false
  if (RESERVED_SET_VAR_NAMES.has(name)) return false
  // 变量名用作 `__flowVars[name]` 的字符串 key；这里校验为兼容 JS 标识符字符集的 Unicode 子集。
  // 支持中文/其它 Unicode 字母：`{{变量名}}`、`{{变量名.length}}` 等可正常解析。
  return /^[$_\p{L}][\p{L}\p{N}_$]*$/u.test(name)
}

function parseScriptVars(raw: unknown): { ok: true; value: VisualFlowScriptVar[] } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, value: [] }
  if (!Array.isArray(raw)) return { ok: false, message: 'visualFlow.scriptVars 须为数组' }
  if (raw.length > 100) return { ok: false, message: '脚本变量数量超过上限 100' }
  const seen = new Set<string>()
  const out: VisualFlowScriptVar[] = []
  for (let i = 0; i < raw.length; i++) {
    const path = `scriptVars[${i}]`
    const item = raw[i]
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, message: `${path} 须为对象` }
    }
    const o = item as Record<string, unknown>
    if (!isNonEmptyString(o.name)) return { ok: false, message: `${path}.name 必填` }
    const name = o.name.trim()
    if (!isValidSetVarName(name)) {
      return { ok: false, message: `${path}.name 须为合法标识符（字母/数字/_$，且非保留名）` }
    }
    if (seen.has(name)) return { ok: false, message: `脚本变量「${name}」重复声明` }
    seen.add(name)
    const description =
      typeof o.description === 'string' && o.description.trim() ? o.description.trim().slice(0, 500) : undefined
    const defaultValue = o.defaultValue == null ? '' : typeof o.defaultValue === 'string' ? o.defaultValue : String(o.defaultValue)
    const scopeRaw = typeof o.scope === 'string' ? o.scope.trim() : ''
    const scope =
      scopeRaw === 'global' || scopeRaw === 'local' || scopeRaw === 'temp'
        ? (scopeRaw as 'global' | 'local' | 'temp')
        : undefined
    out.push({ name, ...(scope ? { scope } : {}), ...(description ? { description } : {}), ...(defaultValue ? { defaultValue } : {}) })
  }
  return { ok: true, value: out }
}

function parseSingleMockRule(o: Record<string, unknown>, path: string): { ok: true; value: NetworkMockRule } | { ok: false; message: string } {
  const urlPattern = typeof o.urlPattern === 'string' && o.urlPattern.trim() ? o.urlPattern.trim() : ""
  const urlRegex = typeof o.urlRegex === 'string' && o.urlRegex.trim() ? o.urlRegex.trim() : ""
  if (!urlPattern && !urlRegex) return { ok: false, message: `${path}.urlPattern 或 urlRegex 必填其一` }
  if (urlPattern && urlPattern.length > 1000) return { ok: false, message: `${path}.urlPattern 过长` }
  if (urlRegex) { try { new RegExp(urlRegex); } catch { return { ok: false, message: `${path}.urlRegex 无效` }; } }
  const queryParams: Record<string, string> | undefined = o.queryParams != null && typeof o.queryParams === 'object' && !Array.isArray(o.queryParams) ? Object.fromEntries(Object.entries(o.queryParams as Record<string, unknown>).filter(([,v]) => typeof v === 'string').map(([k,v]) => [k, v as string])) : undefined
  const method = typeof o.method === 'string' ? o.method.trim().toUpperCase() : ''
  if (method && !['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) return { ok: false, message: `${path}.method 须为 GET|POST|PUT|DELETE|PATCH` }
  if (!Array.isArray(o.responses) || o.responses.length === 0) return { ok: false, message: `${path}.responses 须为非空数组` }
  if (o.responses.length > 50) return { ok: false, message: `${path}.responses 超过上限 50` }
  const responses: NetworkMockResponse[] = []; const bodyStr = (b: unknown) => String(b)
  for (let j = 0; j < o.responses.length; j++) { const rPath = `${path}.responses[${j}]`; const ri = o.responses[j]; if (!ri || typeof ri !== 'object' || Array.isArray(ri)) return { ok: false, message: `${rPath} 须为对象` }; const r = ri as Record<string, unknown>; if (r.body == null) return { ok: false, message: `${rPath}.body 必填` }; const body = bodyStr(r.body); if (body.length > 1_000_000) return { ok: false, message: `${rPath}.body 过长` }; const status = r.status != null ? Number(r.status) : 200; if (!Number.isFinite(status) || status < 100 || status > 599) return { ok: false, message: `${rPath}.status 须为 100～599` }; const callIndex = r.callIndex != null ? Number(r.callIndex) : undefined; if (callIndex != null && (!Number.isFinite(callIndex) || callIndex < 1)) return { ok: false, message: `${rPath}.callIndex 须为正整数` }; const delay = r.delay != null ? Number(r.delay) : undefined; if (delay != null && (!Number.isFinite(delay) || delay < 0 || delay > 60_000)) return { ok: false, message: `${rPath}.delay 须为 0～60000` }; responses.push({ status: Math.floor(status), body, ...(callIndex != null ? { callIndex: Math.floor(callIndex) } : {}), ...(delay != null ? { delay: Math.floor(delay) } : {}), ...(typeof r.headers === 'object' && r.headers && !Array.isArray(r.headers) && Object.keys(r.headers as object).length > 0 ? { headers: Object.fromEntries(Object.entries(r.headers as Record<string, unknown>).filter(([,v]) => typeof v === 'string').map(([k,v]) => [k, v as string])) } : {}), ...(typeof r.requestBodyMatch === 'object' && r.requestBodyMatch && !Array.isArray(r.requestBodyMatch) && Object.keys(r.requestBodyMatch as object).length > 0 ? { requestBodyMatch: Object.fromEntries(Object.entries(r.requestBodyMatch as Record<string, unknown>).filter(([,v]) => typeof v === 'string').map(([k,v]) => [k, v as string])) } : {}) }) }
  const description = typeof o.description === 'string' && o.description.trim() ? o.description.trim().slice(0, 500) : undefined
  return { ok: true, value: { ...(urlPattern ? { urlPattern } : {}), ...(urlRegex ? { urlRegex } : {}), ...(queryParams && Object.keys(queryParams).length > 0 ? { queryParams } : {}), ...(method ? { method: method as NetworkMockRule['method'] } : {}), responses, ...(description ? { description } : {}) } }
}

function parseNetworkMocks(raw: unknown): { ok: true; value: NetworkMockRule[] } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, value: [] }
  if (!Array.isArray(raw)) return { ok: false, message: 'visualFlow.networkMocks 须为数组' }
  if (raw.length > 50) return { ok: false, message: 'mock 规则数量超过上限 50' }
  const out: NetworkMockRule[] = []
  for (let i = 0; i < raw.length; i++) {
    const path = `networkMocks[${i}]`
    const item = raw[i]
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, message: `${path} 须为对象` }
    }
    const o = item as Record<string, unknown>
    const urlPattern = typeof o.urlPattern === 'string' && o.urlPattern.trim() ? o.urlPattern.trim() : ""
    const urlRegex = typeof o.urlRegex === 'string' && o.urlRegex.trim() ? o.urlRegex.trim() : ""
    if (!urlPattern && !urlRegex) return { ok: false, message: `${path}.urlPattern 或 urlRegex 必填其一` }
    if (urlPattern && urlPattern.length > 1000) return { ok: false, message: `${path}.urlPattern 过长` }
    if (urlRegex) {
      try { new RegExp(urlRegex); } catch { return { ok: false, message: `${path}.urlRegex 不是有效的正则表达式` }; }
    }
    const queryParams: Record<string, string> | undefined =
      o.queryParams != null && typeof o.queryParams === 'object' && !Array.isArray(o.queryParams)
        ? Object.fromEntries(Object.entries(o.queryParams as Record<string, unknown>).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, v as string]))
        : undefined
    const method = typeof o.method === 'string' ? o.method.trim().toUpperCase() : ''
    if (method && !['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
      return { ok: false, message: `${path}.method 须为 GET|POST|PUT|DELETE|PATCH` }
    }
    if (!Array.isArray(o.responses) || o.responses.length === 0) {
      return { ok: false, message: `${path}.responses 须为非空数组` }
    }
    if (o.responses.length > 50) {
      return { ok: false, message: `${path}.responses 数量超过上限 50` }
    }
    const responses: NetworkMockResponse[] = []
    for (let j = 0; j < o.responses.length; j++) {
      const rPath = `${path}.responses[${j}]`
      const rItem = o.responses[j]
      if (!rItem || typeof rItem !== 'object' || Array.isArray(rItem)) {
        return { ok: false, message: `${rPath} 须为对象` }
      }
      const r = rItem as Record<string, unknown>
      if (r.body == null) return { ok: false, message: `${rPath}.body 必填` }
      const body = String(r.body)
      if (body.length > 1_000_000) return { ok: false, message: `${rPath}.body 过长（上限 1MB）` }
      const status = r.status != null ? Number(r.status) : 200
      if (!Number.isFinite(status) || status < 100 || status > 599) {
        return { ok: false, message: `${rPath}.status 须为 100～599` }
      }
      const callIndex = r.callIndex != null ? Number(r.callIndex) : undefined
      if (callIndex != null && (!Number.isFinite(callIndex) || callIndex < 1)) {
        return { ok: false, message: `${rPath}.callIndex 须为正整数` }
      }
      const delay = r.delay != null ? Number(r.delay) : undefined
      if (delay != null && (!Number.isFinite(delay) || delay < 0 || delay > 60_000)) {
        return { ok: false, message: `${rPath}.delay 须为 0～60000` }
      }
      const headers: Record<string, string> | undefined =
        r.headers != null && typeof r.headers === 'object' && !Array.isArray(r.headers)
          ? Object.fromEntries(
              Object.entries(r.headers as Record<string, unknown>)
                .filter(([, v]) => typeof v === 'string')
                .map(([k, v]) => [k, v as string]),
            )
          : undefined
      const requestBodyMatch: Record<string, string> | undefined =
        r.requestBodyMatch != null && typeof r.requestBodyMatch === 'object' && !Array.isArray(r.requestBodyMatch)
          ? Object.fromEntries(
              Object.entries(r.requestBodyMatch as Record<string, unknown>)
                .filter(([, v]) => typeof v === 'string')
                .map(([k, v]) => [k, v as string]),
            )
          : undefined
      responses.push({
        status: Math.floor(status),
        body,
        ...(callIndex != null ? { callIndex: Math.floor(callIndex) } : {}),
        ...(delay != null ? { delay: Math.floor(delay) } : {}),
        ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
        ...(requestBodyMatch && Object.keys(requestBodyMatch).length > 0 ? { requestBodyMatch } : {}),
      })
    }
    const description = typeof o.description === 'string' && o.description.trim()
      ? o.description.trim().slice(0, 500)
      : undefined
    out.push({
      ...(urlPattern ? { urlPattern } : {}),
      ...(urlRegex ? { urlRegex } : {}),
      ...(queryParams && Object.keys(queryParams).length > 0 ? { queryParams } : {}),
      ...(method ? { method: method as NetworkMockRule['method'] } : {}),
      responses,
      ...(description ? { description } : {}),
    })
  }
  return { ok: true, value: out }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function parseStep(raw: unknown, path: string): { ok: true; step: VisualStep } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: `${path} 须为对象` }
  }
  const o = raw as Record<string, unknown>
  const t = o.type
  if (!isNonEmptyString(t)) {
    return { ok: false, message: `${path}.type 无效` }
  }
  switch (t.trim()) {
    case 'launch': {
      if (!isNonEmptyString(o.packageName)) return { ok: false, message: `${path}.packageName 必填` }
      return { ok: true, step: { type: 'launch', packageName: o.packageName.trim() } }
    }
    case 'installApp': {
      if (!isNonEmptyString(o.appRef)) return { ok: false, message: `${path}.appRef 必填` }
      return { ok: true, step: { type: 'installApp', appRef: o.appRef.trim() } }
    }
    case 'uninstallApp': {
      if (!isNonEmptyString(o.bundleId)) return { ok: false, message: `${path}.bundleId 必填` }
      return { ok: true, step: { type: 'uninstallApp', bundleId: o.bundleId.trim() } }
    }
    case 'closeApp': {
      if (!isNonEmptyString(o.packageName)) return { ok: false, message: `${path}.packageName 必填` }
      return { ok: true, step: { type: 'closeApp', packageName: o.packageName.trim() } }
    }
    case 'setAIActContext': {
      if (!isNonEmptyString(o.prompt)) return { ok: false, message: `${path}.prompt 必填` }
      return { ok: true, step: { type: 'setAIActContext', prompt: o.prompt.trim() } }
    }
    case 'recordToReport': {
      const title = o.title == null ? '' : String(o.title)
      const content = o.content == null ? '' : String(o.content)
      if (title.length > 500) return { ok: false, message: `${path}.title 过长` }
      if (content.length > 20_000) return { ok: false, message: `${path}.content 过长` }
      return { ok: true, step: { type: 'recordToReport', title, content } }
    }
    case 'assert': {
      if (!isNonEmptyString(o.prompt)) return { ok: false, message: `${path}.prompt 必填` }
      return { ok: true, step: { type: 'assert', prompt: o.prompt.trim() } }
    }
    case 'sleep': {
      const ms = Number(o.ms)
      if (!Number.isFinite(ms) || ms < 0 || ms > 3_600_000) {
        return { ok: false, message: `${path}.ms 须为 0～3600000 的数字` }
      }
      return { ok: true, step: { type: 'sleep', ms: Math.floor(ms) } }
    }
    case 'aiAct': {
      if (!isNonEmptyString(o.prompt)) return { ok: false, message: `${path}.prompt 必填` }
      return { ok: true, step: { type: 'aiAct', prompt: o.prompt.trim() } }
    }
    case 'if': {
      if (!isNonEmptyString(o.conditionPrompt)) {
        return { ok: false, message: `${path}.conditionPrompt 必填` }
      }
      if (!Array.isArray(o.thenSteps) || o.thenSteps.length === 0) {
        return { ok: false, message: `${path}.thenSteps 须为非空数组` }
      }
      const thenSteps: VisualStep[] = []
      for (let i = 0; i < o.thenSteps.length; i++) {
        const r = parseStep(o.thenSteps[i], `${path}.thenSteps[${i}]`)
        if (!r.ok) return r
        thenSteps.push(r.step)
      }
      let elseSteps: VisualStep[] | undefined
      // `null` 与缺省等价：部分 JSON/序列化会把「无 else」写成 elseSteps:null，`!== undefined` 会误判为「有字段」进而报「须为数组」
      if (o.elseSteps != null) {
        if (!Array.isArray(o.elseSteps)) return { ok: false, message: `${path}.elseSteps 须为数组` }
        elseSteps = []
        for (let i = 0; i < o.elseSteps.length; i++) {
          const r = parseStep(o.elseSteps[i], `${path}.elseSteps[${i}]`)
          if (!r.ok) return r
          elseSteps.push(r.step)
        }
      }
      return {
        ok: true,
        step: {
          type: 'if',
          conditionPrompt: o.conditionPrompt.trim(),
          thenSteps,
          ...(elseSteps && elseSteps.length > 0 ? { elseSteps } : {}),
        },
      }
    }
    case 'ifDeviceType': {
      const it = typeof o.interfaceType === 'string' ? o.interfaceType.trim() : ''
      if (!['android', 'ios', 'harmony'].includes(it)) {
        return { ok: false, message: `${path}.interfaceType 须为 android|ios|harmony` }
      }
      if (!Array.isArray(o.thenSteps) || o.thenSteps.length === 0) {
        return { ok: false, message: `${path}.thenSteps 须为非空数组` }
      }
      const thenSteps: VisualStep[] = []
      for (let i = 0; i < o.thenSteps.length; i++) {
        const r = parseStep(o.thenSteps[i], `${path}.thenSteps[${i}]`)
        if (!r.ok) return r
        thenSteps.push(r.step)
      }
      let elseSteps: VisualStep[] | undefined
      // `null` 与缺省等价：部分 JSON/序列化会把「无 else」写成 elseSteps:null，`!== undefined` 会误判为「有字段」进而报「须为数组」
      if (o.elseSteps != null) {
        if (!Array.isArray(o.elseSteps)) return { ok: false, message: `${path}.elseSteps 须为数组` }
        elseSteps = []
        for (let i = 0; i < o.elseSteps.length; i++) {
          const r = parseStep(o.elseSteps[i], `${path}.elseSteps[${i}]`)
          if (!r.ok) return r
          elseSteps.push(r.step)
        }
      }
      return {
        ok: true,
        step: {
          type: 'ifDeviceType',
          interfaceType: it as 'android' | 'ios' | 'harmony',
          thenSteps,
          ...(elseSteps && elseSteps.length > 0 ? { elseSteps } : {}),
        },
      }
    }
    case 'whileLoop': {
      if (!isNonEmptyString(o.conditionPrompt)) {
        return { ok: false, message: `${path}.conditionPrompt 必填` }
      }
      const maxIterations = Number(o.maxIterations)
      if (!Number.isFinite(maxIterations) || maxIterations < 1 || maxIterations > 1000) {
        return { ok: false, message: `${path}.maxIterations 须为 1～1000 的整数` }
      }
      if (!Array.isArray(o.bodySteps) || o.bodySteps.length === 0) {
        return { ok: false, message: `${path}.bodySteps 须为非空数组` }
      }
      const bodySteps: VisualStep[] = []
      for (let i = 0; i < o.bodySteps.length; i++) {
        const r = parseStep(o.bodySteps[i], `${path}.bodySteps[${i}]`)
        if (!r.ok) return r
        bodySteps.push(r.step)
      }
      return {
        ok: true,
        step: {
          type: 'whileLoop',
          conditionPrompt: o.conditionPrompt.trim(),
          maxIterations: Math.floor(maxIterations),
          bodySteps,
        },
      }
    }
    case 'forLoop': {
      const count = Number(o.count)
      if (!Number.isFinite(count) || count < 1 || count > 500) {
        return { ok: false, message: `${path}.count 须为 1～500 的整数` }
      }
      if (!Array.isArray(o.bodySteps) || o.bodySteps.length === 0) {
        return { ok: false, message: `${path}.bodySteps 须为非空数组` }
      }
      const bodySteps: VisualStep[] = []
      for (let i = 0; i < o.bodySteps.length; i++) {
        const r = parseStep(o.bodySteps[i], `${path}.bodySteps[${i}]`)
        if (!r.ok) return r
        bodySteps.push(r.step)
      }
      return {
        ok: true,
        step: {
          type: 'forLoop',
          count: Math.floor(count),
          bodySteps,
        },
      }
    }
    case 'setVar': {
      if (!isNonEmptyString(o.name)) return { ok: false, message: `${path}.name 必填` }
      const name = o.name.trim()
      if (!isValidSetVarName(name)) {
        return {
          ok: false,
          message: `${path}.name 须为合法标识符（字母/数字/_$，且非保留名如 agent、page）`,
        }
      }
      const method = o.method
      if (typeof method !== 'string' || !SET_VAR_METHODS.has(method.trim())) {
        return { ok: false, message: `${path}.method 须为 aiQuery|aiAsk|aiBoolean|aiNumber|aiString` }
      }
      if (!isNonEmptyString(o.expression)) return { ok: false, message: `${path}.expression 必填` }
      const expression = o.expression.trim()
      if (expression.length > 50_000) {
        return { ok: false, message: `${path}.expression 过长` }
      }
      return {
        ok: true,
        step: {
          type: 'setVar',
          name,
          method: method.trim() as 'aiQuery' | 'aiAsk' | 'aiBoolean' | 'aiNumber' | 'aiString',
          expression,
        },
      }
    }
    case 'assignVar': {
      if (!isNonEmptyString(o.name)) return { ok: false, message: `${path}.name 必填` }
      const name = o.name.trim()
      if (!isValidSetVarName(name)) {
        return { ok: false, message: `${path}.name 须为合法标识符（字母/数字/_$，且非保留名）` }
      }
      const value = o.value == null ? '' : String(o.value)
      if (value.length > 50_000) return { ok: false, message: `${path}.value 过长` }
      return { ok: true, step: { type: 'assignVar', name, value } }
    }
    case 'transformVar': {
      if (!isNonEmptyString(o.name)) return { ok: false, message: `${path}.name 必填` }
      const name = o.name.trim()
      if (!isValidSetVarName(name)) {
        return { ok: false, message: `${path}.name 须为合法标识符（字母/数字/_$，且非保留名）` }
      }
      const rule = typeof o.rule === 'string' ? o.rule.trim() : ''
      if (!TRANSFORM_VAR_RULES.has(rule)) {
        return { ok: false, message: `${path}.rule 须为 onlyNumber|cut|jsonPath|replace|handleAmount` }
      }
      const str = (v: unknown) => (v == null ? undefined : String(v))
      return {
        ok: true,
        step: {
          type: 'transformVar',
          name,
          rule: rule as 'onlyNumber' | 'cut' | 'jsonPath' | 'replace' | 'handleAmount',
          ...(str(o.source) !== undefined ? { source: str(o.source)! } : {}),
          ...(str(o.start) !== undefined ? { start: str(o.start)! } : {}),
          ...(str(o.end) !== undefined ? { end: str(o.end)! } : {}),
          ...(str(o.jsonPath) !== undefined ? { jsonPath: str(o.jsonPath)! } : {}),
          ...(str(o.pattern) !== undefined ? { pattern: str(o.pattern)! } : {}),
          ...(str(o.replacement) !== undefined ? { replacement: str(o.replacement)! } : {}),
        },
      }
    }
    case 'setMock': {
      if (!o.rule || typeof o.rule !== 'object' || Array.isArray(o.rule)) {
        return { ok: false, message: `${path}.rule 须为 NetworkMockRule 对象` };
      }
      const mockParsed = parseSingleMockRule(o.rule as Record<string, unknown>, `${path}.rule`);
      if (!mockParsed.ok) return mockParsed;
      return { ok: true, step: { type: 'setMock', rule: mockParsed.value } };
    }
    case 'removeMock': {
      if (!isNonEmptyString(o.urlPattern)) return { ok: false, message: `${path}.urlPattern 必填` };
      return { ok: true, step: { type: 'removeMock', urlPattern: o.urlPattern.trim() } };
    }
    case 'clearMocks': {
      return { ok: true, step: { type: 'clearMocks' } };
    }
    case 'callScript': {
      if (!isNonEmptyString(o.targetTestCaseId)) {
        return { ok: false, message: `${path}.targetTestCaseId 必填` }
      }
      const tid = o.targetTestCaseId.trim()
      if (!/^[a-f\d]{24}$/i.test(tid)) {
        return { ok: false, message: `${path}.targetTestCaseId 须为 24 位 hex 的脚本 id` }
      }
      const scopeId = typeof o.scopeId === 'string' ? o.scopeId.trim() : ''
      if (!/^sub[a-f0-9]{12}$/i.test(scopeId)) {
        return { ok: false, message: `${path}.scopeId 须为 sub 后跟 12 位十六进制` }
      }
      const targetName =
        typeof o.targetName === 'string' && o.targetName.trim() ? o.targetName.trim() : undefined
      const vbRaw = o.varBindings
      const varBindings: Record<string, string> = {}
      if (vbRaw != null && typeof vbRaw === 'object' && !Array.isArray(vbRaw)) {
        for (const [k, v] of Object.entries(vbRaw as Record<string, unknown>)) {
          const kk = String(k).trim()
          if (!isValidSetVarName(kk)) continue
          varBindings[kk] = v == null ? '' : typeof v === 'string' ? v : String(v)
        }
      }
      return {
        ok: true,
        step: {
          type: 'callScript',
          targetTestCaseId: tid,
          ...(targetName ? { targetName } : {}),
          scopeId,
          varBindings,
        },
      }
    }
    default:
      return { ok: false, message: `${path}.type 应使用 IR 步骤类型表中的枚举` }
  }
}

function validateSetVarSequential(
  steps: VisualStep[],
  inherited: Set<string>,
  pathPrefix: string,
): { ok: true } | { ok: false; message: string } {
  const seen = new Set(inherited)
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!
    const path = `${pathPrefix}[${i}]`
    if (s.type === 'setVar') {
      if (seen.has(s.name)) {
        return { ok: false, message: `变量「${s.name}」在同一线性序列中重复声明（${path}）` }
      }
      seen.add(s.name)
    } else if (s.type === 'if' || s.type === 'ifDeviceType') {
      const rThen = validateSetVarSequential(s.thenSteps, new Set(seen), `${path}.thenSteps`)
      if (!rThen.ok) return rThen
      if (s.elseSteps && s.elseSteps.length > 0) {
        const rElse = validateSetVarSequential(s.elseSteps, new Set(seen), `${path}.elseSteps`)
        if (!rElse.ok) return rElse
      }
    } else if (s.type === 'whileLoop') {
      const r = validateSetVarSequential(s.bodySteps, new Set(seen), `${path}.bodySteps`)
      if (!r.ok) return r
    } else if (s.type === 'forLoop') {
      const r = validateSetVarSequential(s.bodySteps, new Set(seen), `${path}.bodySteps`)
      if (!r.ok) return r
    }
  }
  return { ok: true }
}

function collectDeclaredVarNames(steps: VisualStep[], out: Set<string>): void {
  for (const step of steps) {
    if (step.type === 'setVar' || step.type === 'assignVar' || step.type === 'transformVar') {
      out.add(step.name)
    } else if (step.type === 'if' || step.type === 'ifDeviceType') {
      collectDeclaredVarNames(step.thenSteps, out)
      if (step.elseSteps) collectDeclaredVarNames(step.elseSteps, out)
    } else if (step.type === 'whileLoop' || step.type === 'forLoop') {
      collectDeclaredVarNames(step.bodySteps, out)
    }
  }
}

function identifierCharRe(): RegExp {
  // 这里只用于区分 `time` 与 `timestamp` 这类英文标识符前缀；中文自然语言经常紧贴变量名，
  // 例如 `timeBefore和timeAfter不同`，因此边界判断以 ASCII 标识符字符为准。
  return /[$_A-Za-z0-9]/
}

function interpolationRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  const re = /\{\{[^}]+\}\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length })
  }
  return ranges
}

function inAnyRange(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => index >= range.start && index < range.end)
}

function findBareVariableReference(text: string, varNames: Set<string>): string | undefined {
  if (!text || varNames.size === 0) return undefined
  const ranges = interpolationRanges(text)
  const idChar = identifierCharRe()
  const names = [...varNames].sort((a, b) => b.length - a.length)
  for (const name of names) {
    let from = 0
    while (from < text.length) {
      const index = text.indexOf(name, from)
      if (index < 0) break
      from = index + name.length
      if (inAnyRange(index, ranges)) continue
      const prev = index > 0 ? text[index - 1] : ''
      const next = index + name.length < text.length ? text[index + name.length] : ''
      if ((prev && idChar.test(prev)) || (next && idChar.test(next))) continue
      return name
    }
  }
  return undefined
}

function validateInterpolatedVariableReferences(
  steps: VisualStep[],
  declaredNames: Set<string>,
  pathPrefix: string,
): { ok: true } | { ok: false; message: string } {
  const check = (value: string | undefined, path: string): { ok: true } | { ok: false; message: string } => {
    if (value == null) return { ok: true }
    const name = findBareVariableReference(value, declaredNames)
    if (!name) return { ok: true }
    return { ok: false, message: `${path} 中变量「${name}」请写成 {{${name}}}` }
  }

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!
    const path = `${pathPrefix}[${i}]`
    switch (s.type) {
      case 'assert':
      case 'aiAct':
      case 'setAIActContext': {
        const r = check(s.prompt, `${path}.prompt`)
        if (!r.ok) return r
        break
      }
      case 'recordToReport': {
        const title = check(s.title, `${path}.title`)
        if (!title.ok) return title
        const content = check(s.content, `${path}.content`)
        if (!content.ok) return content
        break
      }
      case 'if': {
        const cond = check(s.conditionPrompt, `${path}.conditionPrompt`)
        if (!cond.ok) return cond
        const thenResult = validateInterpolatedVariableReferences(s.thenSteps, declaredNames, `${path}.thenSteps`)
        if (!thenResult.ok) return thenResult
        if (s.elseSteps) {
          const elseResult = validateInterpolatedVariableReferences(s.elseSteps, declaredNames, `${path}.elseSteps`)
          if (!elseResult.ok) return elseResult
        }
        break
      }
      case 'whileLoop': {
        const cond = check(s.conditionPrompt, `${path}.conditionPrompt`)
        if (!cond.ok) return cond
        const body = validateInterpolatedVariableReferences(s.bodySteps, declaredNames, `${path}.bodySteps`)
        if (!body.ok) return body
        break
      }
      case 'forLoop': {
        const body = validateInterpolatedVariableReferences(s.bodySteps, declaredNames, `${path}.bodySteps`)
        if (!body.ok) return body
        break
      }
      case 'setVar': {
        const r = check(s.expression, `${path}.expression`)
        if (!r.ok) return r
        break
      }
      case 'assignVar': {
        const r = check(s.value, `${path}.value`)
        if (!r.ok) return r
        break
      }
      case 'transformVar': {
        const source = check(s.source, `${path}.source`)
        if (!source.ok) return source
        const start = check(s.start, `${path}.start`)
        if (!start.ok) return start
        const end = check(s.end, `${path}.end`)
        if (!end.ok) return end
        const jsonPath = check(s.jsonPath, `${path}.jsonPath`)
        if (!jsonPath.ok) return jsonPath
        const pattern = check(s.pattern, `${path}.pattern`)
        if (!pattern.ok) return pattern
        const replacement = check(s.replacement, `${path}.replacement`)
        if (!replacement.ok) return replacement
        break
      }
      case 'callScript': {
        for (const [key, value] of Object.entries(s.varBindings)) {
          const r = check(value, `${path}.varBindings.${key}`)
          if (!r.ok) return r
        }
        break
      }
      case 'launch':
      case 'installApp':
      case 'uninstallApp':
      case 'closeApp':
      case 'sleep':
      case 'ifDeviceType':
        if (s.type === 'ifDeviceType') {
          const thenResult = validateInterpolatedVariableReferences(s.thenSteps, declaredNames, `${path}.thenSteps`)
          if (!thenResult.ok) return thenResult
          if (s.elseSteps) {
            const elseResult = validateInterpolatedVariableReferences(s.elseSteps, declaredNames, `${path}.elseSteps`)
            if (!elseResult.ok) return elseResult
          }
        }
        break
    }
  }
  return { ok: true }
}

export function tryParseVisualFlow(raw: unknown): { ok: true; value: VisualFlowDocument } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'visualFlow 须为对象' }
  }
  const o = raw as Record<string, unknown>
  const ver = o.version
  const verOk =
    ver === VISUAL_FLOW_VERSION ||
    (typeof ver === 'number' && Number.isFinite(ver) && Math.trunc(ver) === VISUAL_FLOW_VERSION) ||
    (typeof ver === 'string' && String(ver).trim() === String(VISUAL_FLOW_VERSION))
  if (!verOk) {
    return { ok: false, message: `visualFlow.version 须为 ${VISUAL_FLOW_VERSION}` }
  }
  if (!Array.isArray(o.steps)) {
    return { ok: false, message: 'visualFlow.steps 须为数组' }
  }
  if (o.steps.length > 500) {
    return { ok: false, message: '步骤数量超过上限 500' }
  }
  const scriptVarsParsed = parseScriptVars(o.scriptVars)
  if (!scriptVarsParsed.ok) return scriptVarsParsed
  const networkMocksParsed = parseNetworkMocks(o.networkMocks)
  if (!networkMocksParsed.ok) return networkMocksParsed
  const steps: VisualStep[] = []
  for (let i = 0; i < o.steps.length; i++) {
    const r = parseStep(o.steps[i], `steps[${i}]`)
    if (!r.ok) return r
    steps.push(r.step)
  }
  const seq = validateSetVarSequential(steps, new Set(scriptVarsParsed.value.map((v) => v.name)), 'steps')
  if (!seq.ok) return seq
  const declaredVarNames = new Set(scriptVarsParsed.value.map((v) => v.name))
  collectDeclaredVarNames(steps, declaredVarNames)
  const interpolated = validateInterpolatedVariableReferences(steps, declaredVarNames, 'steps')
  if (!interpolated.ok) return interpolated
  return {
    ok: true,
    value: {
      version: VISUAL_FLOW_VERSION,
      ...(scriptVarsParsed.value.length ? { scriptVars: scriptVarsParsed.value } : {}),
      steps,
      ...(networkMocksParsed.value.length ? { networkMocks: networkMocksParsed.value } : {}),
    },
  }
}
