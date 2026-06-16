/**
 * 可视化编排 IR（与 Midscene 业务脚本双写：存库 + 生成 `scriptContent`）。
 * 版本字段便于后续迁移；步骤与 {@link generateScriptFromVisualFlow} 对齐。
 */
export const VISUAL_FLOW_VERSION = 2 as const

export type VisualFlowScriptVar = {
  /** 执行前输入变量名；可被当前脚本及子脚本绑定值中的 `{{name}}` 引用 */
  name: string
  /** 变量作用域；Testin 迁移中 `global` 变量按名共享，局部/临时变量按脚本隔离 */
  scope?: 'global' | 'local' | 'temp'
  /** 展示说明，不参与代码生成 */
  description?: string
  /** 保存编排时写入 `scriptTemplateVars` 的默认值 */
  defaultValue?: string
}

/** 单条可编排步骤（`if` 可嵌套子步骤） */
export type VisualStep =
  | { type: 'launch'; packageName: string }
  /** 安装应用：`appRef` 为本地路径、file://、或 http(s) 下载地址；由 Agent HTTP 同步执行 */
  | { type: 'installApp'; appRef: string }
  /** 卸载应用：Android 包名 / iOS bundle id / 鸿蒙 bundle name */
  | { type: 'uninstallApp'; bundleId: string }
  /** 关闭应用：生成代码在存在 `agent.terminate` 时用其，否则 Android 侧用 `am force-stop` */
  | { type: 'closeApp'; packageName: string }
  /** 同步写入 Agent 的 aiAct 规划上下文（`setAIActContext`） */
  | { type: 'setAIActContext'; prompt: string }
  /** 报告节点截图（`recordToReport`） */
  | { type: 'recordToReport'; title: string; content: string }
  | { type: 'assert'; prompt: string }
  | { type: 'sleep'; ms: number }
  | { type: 'aiAct'; prompt: string }
  | {
      type: 'if'
      conditionPrompt: string
      thenSteps: VisualStep[]
      elseSteps?: VisualStep[]
    }
  /**
   * 按设备类型分支：生成代码直接比较 `agent.interface.interfaceType`，**不调用** aiBoolean，省 token。
   * 与 Midscene 约定一致：`android` | `ios` | `harmony`。
   */
  | {
      type: 'ifDeviceType'
      interfaceType: 'android' | 'ios' | 'harmony'
      thenSteps: VisualStep[]
      elseSteps?: VisualStep[]
    }
  /** 条件为真则执行循环体，每轮开头 `aiBoolean`；`maxIterations` 硬上限防死循环 */
  | {
      type: 'whileLoop'
      conditionPrompt: string
      maxIterations: number
      bodySteps: VisualStep[]
    }
  /** 固定次数循环 */
  | {
      type: 'forLoop'
      count: number
      bodySteps: VisualStep[]
    }
  /**
   * 从 Insight 类 API 写入变量，供后续步骤在文案中用 `{{变量名}}` 引用。
   * 生成：`__flowVars[name] = await agent.aiQuery|aiAsk|…`
   */
  | {
      type: 'setVar'
      /** 合法 JS 标识符，且不得与运行时保留名冲突 */
      name: string
      method: 'aiQuery' | 'aiAsk' | 'aiBoolean' | 'aiNumber' | 'aiString'
      /**
       * aiQuery：纯字符串需求，或整段 JSON（对象/数组）作为 dataDemand；
       * 其余方法：传给对应 API 的 prompt 字符串。
       */
      expression: string
    }
  /** 直接给流程变量赋值；`value` 支持 `{{变量名}}` 插值。 */
  | {
      type: 'assignVar'
      name: string
      value: string
    }
  /** 对现有流程变量做确定性文本处理。 */
  | {
      type: 'transformVar'
      name: string
      rule: 'onlyNumber' | 'cut' | 'jsonPath' | 'replace' | 'handleAmount'
      source?: string
      start?: string
      end?: string
      jsonPath?: string
      pattern?: string
      replacement?: string
    }
  /**
   * 调用另一条测试用例：优先展开其 `visualFlow`（与当前脚本共享 `__flowStep` 序号链）；
   * 若无有效编排则内联其 `scriptContent`（变量由脚本顶部注入的 `__FLOW_DATA` / `__scoped` 等提供）。
   */
  | {
      type: 'callScript'
      targetTestCaseId: string
      /** 展示用；可选 */
      targetName?: string
      /** 与 `scriptTemplateVars` 嵌套键一致，须唯一（如 `sub`+hex） */
      scopeId: string
      /** 经 `scopeId` 归并后的扁平变量名 → 值；保存编排时并入用例 `scriptTemplateVars[scopeId]` */
      varBindings: Record<string, string>
    }

export interface VisualFlowDocument {
  version: typeof VISUAL_FLOW_VERSION
  scriptVars?: VisualFlowScriptVar[]
  steps: VisualStep[]
}
