# 可视化编排 IR（供模型生成 JSON）

本文档供 **对话编排 / 自动生成 `visualFlow`** 的系统提示使用：只描述 **JSON 形状、字段含义与校验约束**，不含代码生成、HTTP 接口等平台实现细节。人类可读的平台语义、codegen 对照与落库说明见 `**VISUAL_FLOW_IR.md`**；字段以 `**backend/src/contexts/visual-flow/types.ts`**、校验以 `**validate.ts`** 为准。

---

## 1. 根对象 `VisualFlowDocument`


| 字段           | 必填  | 说明                                   |
| ------------ | --- | ------------------------------------ |
| `version`    | 是   | 固定为数字 `2`，其它值保存失败。                   |
| `scriptVars` | 否   | 执行前由人填的变量声明数组；步骤文案里用 `{{变量名}}` 引用。   |
| `networkMocks` | 否   | 网络 mock 规则数组，在测试开始前启动代理并配置到设备。每条规则描述一个 API 的 URL 匹配与 mock 响应序列。 |
| `steps`      | 是   | 顶层步骤数组，按顺序执行；**展开后总条数 ≤ 500**（含子步骤）。 |


### 1.1 `scriptVars[]` 每项


| 字段             | 必填  | 选填 / 备注                            |
| -------------- | --- | ---------------------------------- |
| `name`         | 是   | —                                  |
| `description`  | 否   | 给人看的说明。                            |
| `defaultValue` | 否   | 默认填值，字符串。                          |
| `scope`        | 否   | `global`、`local` 或 `temp`；缺省按平台约定。 |


### 1.2 `networkMocks[]` 每项

| 字段           | 必填  | 说明                                   |
| -------------- | --- | -------------------------------------- |
| `urlPattern`   | 是   | 请求 URL 的子串匹配（`includes` 语义）。首个匹配的规则生效。 |
| `method`       | 否   | HTTP 方法：`GET`、`POST`、`PUT`、`DELETE` 或 `PATCH`。不填则匹配任意方法。 |
| `responses`    | 是   | 非空响应序列数组，按顺序匹配第一项满足条件的响应。 |
| `description`  | 否   | 给人看的说明。 |

#### `responses[]` 每项

| 字段               | 必填  | 说明                                   |
| ------------------ | --- | -------------------------------------- |
| `body`             | 是   | 响应体字符串（通常为 JSON）。上限 1MB。 |
| `status`           | 否   | HTTP 状态码，默认 200。范围 100～599。 |
| `callIndex`        | 否   | 仅第 n 次调用时匹配（1-based）。用于实现状态性 mock：首次返回错误，二次返回成功。 |
| `requestBodyMatch` | 否   | 键值对映射，必须在请求体的 JSON 中存在且值匹配才会命中。 |
| `headers`          | 否   | 额外的响应头。Content-Type 默认为 `application/json; charset=utf-8`。 |
| `delay`            | 否   | 响应延迟毫秒数。范围 0～60000。 |

#### 匹配规则

1. 遍历 `networkMocks`，找到第一条 `urlPattern` 是请求 URL 子串的规则。
2. 递增该规则的调用计数器。
3. 按顺序遍历 `responses`，找到第一项满足 `callIndex` 和 `requestBodyMatch` 的响应并返回。
4. 若无匹配响应或请求不匹配任何规则，透明转发到真实服务器。

#### 示例

```json
{
  "networkMocks": [
    {
      "urlPattern": "getMafangRosterNewFlowSwitch",
      "description": "启用码放新流程",
      "responses": [
        {
          "status": 200,
          "body": "{\"code\":200,\"data\":{\"newFlowEnabled\":true},\"subcode\":200}"
        }
      ]
    },
    {
      "urlPattern": "copyWorkScheduleGroup",
      "method": "POST",
      "description": "日复制先弹确认再成功",
      "responses": [
        {
          "callIndex": 1,
          "status": 200,
          "body": "{\"code\":\"WORK_SCHEDULE_PARTITION_MAFANG_COPY_SKIP_CONFIRM\",\"data\":{\"blockedCount\":2}}"
        },
        {
          "callIndex": 2,
          "requestBodyMatch": {"mafangSkipConfirmed": "true"},
          "status": 200,
          "body": "{\"code\":200,\"data\":{\"flag\":true}}"
        }
      ]
    }
  ]
}
```

---

## 2. 步骤类型与设计原则

### 核心原则：所有 UI 交互都使用 `aiAct`

- `aiAct` 是**唯一**的 UI 交互步骤类型。
- 一个 `aiAct` 覆盖**一个完整的用户意图**，由视觉模型自行规划具体的点击、长按、滑动、输入等动作。
- 例如，"长按第一个订单，在弹出菜单中选择「删除」，如果有确认弹窗则确认删除"——这是一个完整的意图，应当用**一个** `aiAct` 表达。

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
- `networkMocks` 超过 50 条规则或单条规则的 `responses` 超过 50 项 → 失败。
- `networkMocks[].urlPattern` 为空或过长（>1000）→ 失败。
- `networkMocks[].responses` 为空数组 → 失败。
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
  "version": 1,
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

**维护约定**：新增或变更步骤类型时，须同步 `**types.ts`** / `**validate.ts`** / `**VISUAL_FLOW_IR_LLM.md`** / `**VISUAL_FLOW_IR.md`**，保持模型提示与保存校验一致。
