# 可视化编排 IR（供模型生成 JSON）

本文档供 **对话编排 / 自动生成 `visualFlow`** 的系统提示使用：只描述 **JSON 形状、字段含义与校验约束**，不含代码生成、HTTP 接口等平台实现细节。人类可读的平台语义、codegen 对照与落库说明见 `**VISUAL_FLOW_IR.md`**；字段以 `**backend/src/contexts/visual-flow/types.ts`**、校验以 `**validate.ts`** 为准。

---

## 1. 根对象 `VisualFlowDocument`


| 字段           | 必填  | 说明                                   |
| ------------ | --- | ------------------------------------ |
| `version`    | 是   | 固定为数字 `2`，其它值保存失败。                   |
| `scriptVars` | 否   | 执行前由人填的变量声明数组；步骤文案里用 `{{变量名}}` 引用。   |
| `steps`      | 是   | 顶层步骤数组，按顺序执行；**展开后总条数 ≤ 500**（含子步骤）。 |


### 1.1 `scriptVars[]` 每项


| 字段             | 必填  | 选填 / 备注                            |
| -------------- | --- | ---------------------------------- |
| `name`         | 是   | —                                  |
| `description`  | 否   | 给人看的说明。                            |
| `defaultValue` | 否   | 默认填值，字符串。                          |
| `scope`        | 否   | `global`、`local` 或 `temp`；缺省按平台约定。 |


---

## 2. 步骤类型与设计原则

### 核心原则：所有 UI 交互都使用 `aiAct`

- `aiAct` 是**唯一**的 UI 交互步骤类型。
- 一个 `aiAct` 覆盖**一个完整的用户意图**，由视觉模型自行规划具体的点击、长按、滑动、输入等动作。
- 例如，"长按第一个订单，在弹出菜单中选择「删除」，如果有确认弹窗则确认删除"——这是一个完整的意图，应当用**一个** `aiAct` 表达。
- **拆分复杂 aiAct**：当一个 `aiAct` 涉及的独立操作过多时，应拆分为多个更小、更聚焦的步骤。每个 `aiAct` 建议不超过 3-4 个紧密相关的操作。反例：一个步骤包含 6+ 个分散操作（如 操作1 → 操作2 → … → 操作8），模型容易在反复定位中迷失。

### 其他步骤类型

除 `aiAct` 外的步骤类型分为以下几类，各自有明确的非交互用途：

| 类别 | 类型 | 说明 |
|------|------|------|
| **应用管理** | `launch` / `closeApp` / `installApp` / `uninstallApp` | 启动、关闭、安装、卸载应用 |
| **等待** | `sleep` | 固定延时等待（页面跳转、动画、列表更新等） |
| **断言** | `assert` | 视觉断言，验证 UI 状态是否符合预期 |
| **上下文** | `setAIActContext` | 设置后续 `aiAct` 的突发情况处理策略（如权限弹窗、营销弹窗） |
| **报告** | `recordToReport` | 向测试报告写入标题和内容 |
| **变量** | `setVar` / `assignVar` / `transformVar` | 从屏幕读取数据、赋值或转换变量 |
| **流程控制** | `if` / `ifDeviceType` / `whileLoop` / `forLoop` | 条件判断、按设备类型分支、循环 |
| **脚本调用** | `callScript` | 调用其他测试用例 |

### 每条步骤的公共规则

- 每个步骤对象 **必须有** `type`（字符串）。
- `**launch` / `closeApp` / `uninstallApp`**：使用包名类字段（`packageName` 或 `bundleId`）表达应用目标。
- `aiAct` / `assert` / `setAIActContext`：用 `prompt` 写 **短而可执行** 的界面描述（可见文案、区域）。
- 突发情况处理使用 `setAIActContext`：例如 `"遇到权限弹窗请同意，营销弹窗请拒绝"`。该上下文会带给后续 act 操作，由视觉模型自行处理弹窗等临时干扰。
- `prompt` 保持简洁明确，只写必要信息。**`assert` 的 `prompt` 只需写明判断逻辑**，已有变量用 `{{}}` 插值即可，不要重复上下文。好：`"屏幕上的登录状态文本是{{expectedStatus}}"`；差：一段描述"看当前屏幕……由于……说明……"的长句。
- 页面跳转、启动、刷新、动画结束、列表更新等"页面稳定"场景，使用 `sleep` 固定等待（如 2000～5000ms）。
- `assert` 放在关键校验点，通常是本次改动点或必要回归点；普通步骤执行失败会自然阻塞流程。
- `**if` / `ifDeviceType`**：`thenSteps` 非空数组；`**elseSteps`** 为 **选填**：可整段省略、或 `[]`、或 `null`（均表示「无 else 分支」）；若写出 `elseSteps` 且为非空数组，则其中为正常子步骤。
- `**whileLoop` / `forLoop`**：`bodySteps` **非空数组**（无选填分支数组名）。
- **同一条「线性执行路径」上**：`setVar` 的 `name` **不得重复**（含分支内继承规则，与校验一致）。
- `**setVar.name` / `assignVar.name` / `transformVar.name`**：支持 Unicode 字母（含中文）/数字/`_`/`$`，且首字符为非数字；须匹配 `^[$_\\p{L}][\\p{L}\\p{N}_$]*$`（`/u` 语义），长度 1～64，并避开运行时保留名（如 `agent`、`page`、`console`、`process`、`sleep` 等，详见校验）。
- 字符串字段中引用已声明变量时，**必须**使用 `**{{变量名}}`**、`{{变量名[0]}}`、`{{变量名.1}}`、`{{变量名.length}}` 等插值形式；其中 `.length` 用于读取数组长度（非数组按 `0` 处理）。
- 已声明变量在字符串字段中统一使用插值形式；例如已声明 `timeBefore`、`timeAfter` 时，写成 `"{{timeBefore}}和{{timeAfter}}不同"`。

---

## 3. 步骤类型：必填、选填与约束

列 **选填**：除「—」外，写出可出现的字段名；未列出者表示不宜随意加未知键（以 `types.ts` 为准）。


| `type`                                                           | 必填字段                                            | 选填字段                                                      | 说明与取值约束                                                                                                                                                |
| ---------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `launch`                                                         | `packageName`                                   | —                                                         | Android 包名 / iOS bundle id / 鸿蒙 bundle name。                                                                                                           |
| `installApp`                                                     | `appRef`                                        | —                                                         | 本地路径、`file://` 或 `http(s)` 安装包地址。                                                                                                                      |
| `uninstallApp`                                                   | `bundleId`                                      | —                                                         | 要卸载的应用标识。                                                                                                                                              |
| `closeApp`                                                       | `packageName`                                   | —                                                         | 关闭正在运行的应用。                                                                                                                                             |
| `setAIActContext`                                                | `prompt`                                        | —                                                         | 设置后续 aiAct 操作的上下文，适合声明权限弹窗、营销弹窗、升级提示等突发情况处理策略。                                                                                                   |
| `recordToReport`                                                 | `title`, `content`                              | —                                                         | 二者均为字符串，**允许空串**；有长度上限（校验）。                                                                                                                            |
| `assert`                                                         | `prompt`                                        | —                                                         | 断言命题。                                                                                                                                                  |
| `sleep`                                                          | `ms`                                            | —                                                         | 整数 **0～3600000**（毫秒）；页面稳定、动画结束、跳转缓冲使用本步骤。                                                                                                             |
| `aiAct`                                                          | `prompt`                                        | —                                                         | **唯一的 UI 交互步骤类型**。描述完整的用户意图、关键约束和完成条件，让视觉模型自行规划具体操作。                                                                                                 |
| `if`                                                             | `conditionPrompt`, `thenSteps`                  | `**elseSteps`**                                           | 条件为真执行 `thenSteps`；无 else 则省略 `elseSteps` / `[]` / `null`。                                                                                             |
| `ifDeviceType`                                                   | `interfaceType`, `thenSteps`                    | `**elseSteps`**                                           | `interfaceType` 仅 `android`、`ios`、`harmony`；无 else 同上。                                                                                                 |
| `whileLoop`                                                      | `conditionPrompt`, `maxIterations`, `bodySteps` | —                                                         | `maxIterations`：1～1000 整数。                                                                                                                             |
| `forLoop`                                                        | `count`, `bodySteps`                            | —                                                         | `count`：1～500 整数。                                                                                                                                      |
| `setVar`                                                         | `name`, `method`, `expression`                  | —                                                         | `method` 仅 `aiQuery`、`aiAsk`、`aiBoolean`、`aiNumber`、`aiString`。`aiQuery` 的 `expression` 可为自然语言或整段 JSON 抽取需求；其余 method 的 `expression` 为对应 API 的 prompt。 |
| `assignVar`                                                      | `name`, `value`                                 | —                                                         | 字面值或带 `{{}}` 的模板；**不用**于从屏读数（读屏用 `setVar`）。                                                                                                            |
| `transformVar`                                                   | `name`, `rule`                                  | `source`、`start`、`end`、`jsonPath`、`pattern`、`replacement` | `rule`：`onlyNumber`、`cut`、`jsonPath`、`replace`、`handleAmount`；按规则选用上述选填字段。                                                                             |
| `callScript`                                                     | `targetTestCaseId`, `scopeId`, `varBindings`    | `**targetName`**                                          | `targetTestCaseId`：24 位 hex；`scopeId`：`sub` + 12 位小写 hex；`varBindings` 可为 `{}`；`targetName` 仅展示用。                                                      |


步骤 `type` 使用上表枚举；生成后先调用 `validate_visual_flow`，按返回信息修正结构。

---

## 4. 易错校验（生成后自查）

- `version !== 2` → 失败。
- `if` / `ifDeviceType` 的 `thenSteps` 为空，或 `whileLoop` / `forLoop` 的 `bodySteps` 为空 → 失败。
- `sleep.ms`、`whileLoop.maxIterations`、`forLoop.count` 超出上表范围 → 失败。
- `callScript.targetTestCaseId` 非 24 位 hex，或 `scopeId` 不符合 `sub`+12hex → 失败。
- 同一路径重复 `setVar.name` → 失败。
- 声明过的变量在 `prompt` / `value` / `expression` / `varBindings` 等字符串字段中使用 `{{}}` 插值。
- 页面稳定等待使用 `sleep`；关键结果检查使用 `assert`。
- `assert` 聚焦关键校验点，通常是本次改动点或必要回归点。
- **所有 UI 交互必须使用 `aiAct`**。

---

## 5. 完整示例（含 `scriptVars`、条件分支、`assert`）

下列为**可直接通过结构校验**的示意：请把包名、文案改成目标应用真实情况。

```json
{
  "version": 2,
  "scriptVars": [
    { "name": "phone", "description": "登录手机号", "defaultValue": "" }
  ],
  "steps": [
    { "type": "launch", "packageName": "com.example.app" },
    { "type": "setAIActContext", "prompt": "遇到权限弹窗请同意，营销弹窗请拒绝" },
    { "type": "sleep", "ms": 3000 },
    {
      "type": "if",
      "conditionPrompt": "当前是否已在登录页（能看到手机号输入框）",
      "thenSteps": [
        {
          "type": "aiAct",
          "prompt": "在手机号输入框中输入{{phone}}，然后点击「获取验证码」按钮"
        },
        { "type": "sleep", "ms": 3000 },
        { "type": "assert", "prompt": "出现短信验证码输入框或倒计时提示" }
      ],
      "elseSteps": [
        { "type": "aiAct", "prompt": "点击底部或顶部的「我的」或个人中心入口" }
      ]
    },
    { "type": "assert", "prompt": "页面显示已登录态（头像、昵称或「退出登录」其一）" },
    { "type": "sleep", "ms": 500 },
    { "type": "closeApp", "packageName": "com.example.app" }
  ]
}
```

---

## 6. 网络 Mock（`networkMocks` 与运行时步骤）

### 架构约束

TLS CONNECT 握手时只有 **主机名（SNI）** 可见，路径在加密层内。因此：

- **解密门（decrypt gate）**：`hostRegex` — 正则匹配 CONNECT 主机名，决定是否 MITM 该连接。
- **Mock 门（mock gate）**：`pathPattern` / `pathRegex` — 在已解密的请求中匹配路径，决定是否返回 mock 响应。

### `NetworkMockRule` 字段

| 字段            | 必填  | 说明                                                              |
| ------------- | --- | --------------------------------------------------------------- |
| `hostRegex`   | 是   | 正则，匹配 CONNECT 主机（SNI）。示例：`"api\\.example\\.com$"`             |
| `pathPattern` | 否   | 子串匹配请求路径。两者均省略 = 该主机所有路径。                                      |
| `pathRegex`   | 否   | 正则匹配请求路径（与 `pathPattern` 独立，均省略时匹配所有路径）。                        |
| `method`      | 否   | `GET` / `POST` / `PUT` / `DELETE` / `PATCH`；省略 = 任意方法。         |
| `queryParams` | 否   | URL query 参数的精确匹配键值对。                                           |
| `responses`   | 否   | 静态响应数组（XOR with `handler`）；两者均省略 = **仅录制**，不返回 mock。            |
| `handler`     | 否   | 内联 JS 字符串 `(req, ctx) => response \| null`（Task 5 实现执行，此处仅存字段）。 |
| `description` | 否   | 人类可读说明。                                                         |

**`responses` 与 `handler` 互斥**：同时写两者校验报错；两者均省略则规则仅参与录制，`hostnameMatchesAnyRule` 仍返回 `true`，`findMatch` 返回 `null`。

### `responses[]` 每项字段

| 字段                | 必填  | 说明                              |
| ----------------- | --- | ------------------------------- |
| `body`            | 是   | 响应体字符串（通常为 JSON）。               |
| `status`          | 否   | HTTP 状态码，100～599；省略默认 200。      |
| `headers`         | 否   | 附加响应头键值对。                       |
| `delay`           | 否   | 返回前延迟毫秒数（0～60000）。              |
| `callIndex`       | 否   | 仅在第 n 次调用时匹配（1-based）；实现有状态序列。  |

### `VisualFlowDocument.networkMocks`

根对象的 `networkMocks` 字段（可选数组）在测试启动前批量生效。运行时热更新规则请使用 `update_network_mock_rules` MCP 工具（不是步骤类型）。

### 示例

```json
{
  "networkMocks": [
    {
      "hostRegex": "api\\.example\\.com$",
      "pathRegex": "^/v1/orders",
      "method": "GET",
      "responses": [{ "status": 200, "body": "{\"orders\":[]}" }],
      "description": "空订单列表"
    },
    {
      "hostRegex": "api\\.example\\.com$",
      "description": "录制该主机所有流量（record-only，无 responses）"
    }
  ],
  "steps": [
    { "type": "launch", "packageName": "com.example.app" },
    { "type": "aiAct", "prompt": "进入订单列表页" },
    { "type": "assert", "prompt": "列表显示「暂无订单」" }
  ]
}
```

### 易错校验

- `hostRegex` 缺失 → 失败。
- `hostRegex` 不是合法正则 → 失败。
- `hostRegex` 为全匹配（`.*`、`.+`、`.`、空串等）→ 失败：会 MITM 非目标主机。
- `pathRegex` 不是合法正则 → 失败。
- `responses` 与 `handler` 同时存在 → 失败。
- `responses[].body` 缺失 → 失败。
- `responses` 为空数组（`[]`）等同于省略，视为 record-only。

### hostRegex 锚定

`hostRegex` 应锚定，否则会解密（MITM）非目标主机：未锚定的 `example\.com` 会同时命中 `evil-example.com` 与 `example.com.attacker.net`。

- 以 `$` 结尾，并用 `\.` 转义点号，例如 `api\.example\.com$`。
- 需匹配子域时用点边界 `(^|\.)example\.com$`，避免命中 `evil-example.com`。
- 校验会拒绝明显的全匹配模式，但无法穷举所有不安全写法，请自行核实锚定。

---

**维护约定**：新增或变更步骤类型时，须同步 `**types.ts`** / `**validate.ts`** / `**VISUAL_FLOW_IR_LLM.md`** / `**VISUAL_FLOW_IR.md`**，保持模型提示与保存校验一致。
