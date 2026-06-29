# Network Mock — 架构与实践

## 概述

Preflight 的网络 Mock 功能通过本地 MITM HTTPS 代理拦截 Android 模拟器的 API 请求，根据预定义规则返回 mock 响应，支持录制真实流量并导出为可复用的 mock 规则。CA 证书自动安装到模拟器的用户信任存储，无需手动操作。

## 架构

```
┌──────────────┐     ┌─────────────────┐     ┌──────────────┐
│  Android     │────▶│  NetworkMock    │────▶│  Real API     │
│  Emulator    │     │  Server (MITM)  │     │  Servers      │
└──────────────┘     └───────┬─────────┘     └──────────────┘
                             │
                    ┌────────▼─────────┐
                    │  Mock Rules      │
                    │  (Visual Flow IR)│
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │  Recording       │
                    │  Buffer          │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │  Export → Rules  │
                    │  (reusable)      │
                    └──────────────────┘
```

## 核心组件

### NetworkMockServer (`src/mcp/network-mocks/NetworkMockServer.ts`)

HTTP/HTTPS 代理服务器，负责：

- **HTTP 代理**：解析 `GET http://host/path` 格式的代理请求，匹配规则或转发
- **HTTPS MITM**：拦截 CONNECT 请求，用动态生成的服务器证书完成 TLS 握手，解密后匹配规则
- **证书管理**：启动时生成/加载 Root CA，按需为每个域名签发服务器证书（openssl CLI）
- **规则匹配**：`hostRegex` 解密门 → `pathPattern`/`pathRegex` mock 门 → `method` 过滤 → `callIndex` 序列 → `requestBodyMatch` 条件
- **录制引擎**：流式 tee 捕获经过代理的所有请求/响应对（stream-tee 全量录制，不只截取最后 chunk）

### NetworkMockService (`src/mcp/network-mocks/NetworkMockService.ts`)

生命周期管理器：

- `start(config)` — 自动安装 CA → 启动代理服务器 → 配置设备代理（ADB）
- `stop()` — 停止服务器 + 移除设备代理
- `getStats()` — 返回每规则的调用统计
- `updateRules(rules)` — 热更新规则，不中断服务
- `exportRecordedRules()` — 导出录制的流量为 `NetworkMockRule[]`

### device-ca (`src/mcp/network-mocks/device-ca.ts`)

CA 自动安装：`adb root` + 推送证书到 `/data/misc/user/0/cacerts-added/<hash>.0`（Android 用户信任存储），幂等操作。要求模拟器使用可 root 的 AOSP 镜像（非 Play Store 镜像）。

### device-proxy (`src/mcp/network-mocks/device-proxy.ts`)

设备级代理配置：`adb shell settings put global http_proxy <host:port>`

### Visual Flow IR (`src/mcp/visual-flow/types.ts`)

```typescript
interface VisualFlowDocument {
  version: 2
  scriptVars?: VisualFlowScriptVar[]
  steps: VisualStep[]
  networkMocks?: NetworkMockRule[]  // 测试启动前批量生效
}

interface NetworkMockRule {
  hostRegex: string                     // REQUIRED — 正则匹配 CONNECT 主机（SNI），决定是否 MITM
  pathPattern?: string                  // 子串匹配请求路径（mock 门）
  pathRegex?: string                    // 正则匹配请求路径（mock 门）
  queryParams?: Record<string, string>  // URL query 参数精确匹配
  method?: HTTPMethod                   // 可选 HTTP 方法过滤
  responses?: NetworkMockResponse[]     // 静态响应数组，XOR with handler
  handler?: string                      // 内联 JS (req, ctx) => response | null
  description?: string
}

interface NetworkMockResponse {
  body: string                          // REQUIRED — 响应体（通常为 JSON）
  status?: number                       // 默认 200
  headers?: Record<string, string>
  delay?: number                        // 模拟延迟 ms（0～60000）
  callIndex?: number                    // 仅第 N 次调用时匹配（状态序列，1-based）
  requestBodyMatch?: Record<string, string>  // 请求体 JSON 键值对精确匹配
}
```

`responses` 与 `handler` 互斥；两者均省略则规则仅参与录制（record-only）。

## MCP 工具

| 工具 | 说明 |
|------|------|
| `start_network_mocks` | 启动代理服务器，自动安装 CA，配置设备代理 |
| `stop_network_mocks` | 停止代理，移除设备代理配置 |
| `get_network_mock_status` | 查询各规则调用次数 |
| `update_network_mock_rules` | 热更新规则（运行时动态修改） |
| `get_root_ca_cert` | 导出 Root CA 证书（PEM），直接从内存读取 |
| `start_recording` | 开启流量录制 |
| `stop_recording` | 停止录制 |
| `export_recorded_rules` | 导出录制流量为 `NetworkMockRule[]` |

## 标准工作流

### 流程 A：从零开始 mock 一个新 API

```
1. start_network_mocks(rules=[])         — 自动安装 CA，设置设备代理
2. start_recording()
3. 在 app 中操作目标流程
4. stop_recording()
5. export_recorded_rules()  →  得到 NetworkMockRule[]
6. 清理规则（删无关 API，保留目标）
7. update_network_mock_rules()           — 热更新，不重启
8. 重新操作 app → 验证 mock 命中
```

### 流程 B：使用已有 mock 规则跑测试

```
1. run_flow(visualFlow with networkMocks)  →  自动启动 mock + CA 安装
2. 测试运行，mock 自动拦截匹配的 API
3. 测试结束自动停止 mock
```

## CA 安装机制

CA 由 `device-ca.ts` 自动安装，无需手动操作：

1. `adb root` — 切换到 root shell
2. 计算 CA 的 openssl subject hash（`openssl x509 -subject_hash_old`）
3. 推送到 `/data/misc/user/0/cacerts-added/<hash>.0`
4. 检查是否已安装（幂等，已安装则跳过）

**前提**：模拟器须使用可 root 的 AOSP 镜像（`google_apis` 而非 `google_apis_playstore`）。Play Store 镜像的 `adb root` 会被拒绝，CA 安装失败时 `start_network_mocks` 会抛出明确错误。

## 已验证场景

### Android 模拟器 + 维C App

- 设备：Android API 35 模拟器（google_apis，可 root）
- CA 自动安装：adb root + push 到 cacerts-added
- 拦截：多个 API 路径，mock 命中统计正常

## 限制与已知问题

- 仅支持 Android 模拟器（iOS 需手动配置代理和证书，暂不支持自动化）
- 需要可 root 的模拟器镜像（非 Play Store 版本）
- 动态响应生成（如根据请求参数计算）需使用 `handler` 字段（内联 JS）
- 不支持 WebSocket 拦截
