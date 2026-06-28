# Network Mock — 架构与实践

## 概述

Preflight 的网络 Mock 功能通过本地 MITM HTTPS 代理拦截移动设备的 API 请求，根据预定义规则返回 mock 响应，支持录制真实流量并导出为可复用的 mock 规则。

## 架构

```
┌──────────────┐     ┌─────────────────┐     ┌──────────────┐
│  iOS/Android │────▶│  NetworkMock    │────▶│  Real API     │
│  Device      │     │  Server (MITM)  │     │  Servers      │
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
- **规则匹配**：URL 子串匹配 → method 过滤 → callIndex 序列 → requestBodyMatch 条件
- **录制引擎**：捕获经过代理的所有请求/响应对，存储在内存缓冲区

### NetworkMockService (`src/mcp/network-mocks/NetworkMockService.ts`)

生命周期管理器：

- `start(config)` — 启动代理服务器 + 配置设备代理（Android ADB）
- `stop()` — 停止服务器 + 移除设备代理
- `getStats()` — 返回每规则的调用统计
- `updateRules(rules)` — 热更新规则，不中断服务
- `exportRecordedRules()` — 导出录制的流量为 NetworkMockRule[]

### device-proxy (`src/mcp/network-mocks/device-proxy.ts`)

设备级代理配置：

- Android 模拟器：`adb shell settings put global http_proxy`
- iOS 真机：手动 WiFi 代理（Phase 3 将支持 .mobileconfig 一键安装）

### Visual Flow IR (`src/mcp/visual-flow/types.ts`)

```typescript
interface VisualFlowDocument {
  version: 2
  scriptVars?: VisualFlowScriptVar[]
  steps: VisualStep[]
  networkMocks?: NetworkMockRule[]  // 新增
}

interface NetworkMockRule {
  urlPattern: string       // URL 子串匹配
  method?: HTTPMethod      // 可选 HTTP 方法过滤
  responses: NetworkMockResponse[]
  description?: string
}

interface NetworkMockResponse {
  status?: number          // 默认 200
  body: string             // 响应体（通常为 JSON）
  requestBodyMatch?: Record<string, string>  // 请求体条件
  callIndex?: number       // 仅第 N 次调用时匹配（状态序列）
  headers?: Record<string, string>
  delay?: number           // 模拟延迟 ms
}
```

## MCP 工具

| 工具 | 说明 |
|------|------|
| `start_network_mocks` | 启动代理服务器，配置设备代理 |
| `stop_network_mocks` | 停止代理，移除设备代理配置 |
| `get_network_mock_status` | 查询各规则调用次数 |
| `update_network_mock_rules` | 热更新规则 |
| `get_root_ca_cert` | 导出 Root CA 证书（PEM） |
| `start_recording` | 开启流量录制 |
| `stop_recording` | 停止录制 |
| `export_recorded_rules` | 导出录制流量为 NetworkMockRule[] |

## 标准工作流

### 流程 A：从零开始 mock 一个新 API

```
1. start_network_mocks(rules=[])
2. 配 WiFi 代理 + 信任 CA 证书
3. start_recording()
4. 在 app 中操作目标流程
5. stop_recording()
6. export_recorded_rules()  →  得到 NetworkMockRule[]
7. 清理规则（删无关 API，保留目标）
8. update_network_mock_rules()  热更新
9. 重新操作 app → 验证 mock 命中
```

### 流程 B：使用已有 mock 规则跑测试

```
1. run_flow(visualFlow with networkMocks)  →  自动启动 mock
2. 测试运行，mock 自动拦截匹配的 API
3. 测试结束自动停止 mock
```

### 流程 C：从 Quantumult X rewrite.js 迁移

```
1. 将 rewrite.js 中的 API 列表 + mock 数据手动转为 NetworkMockRule[] JSON
2. 使用流程 B 验证
（Phase 5 将支持自动转换）
```

## 已验证场景

### iOS 真机 + 维C App

- 设备：iPhone 18,3 (iOS 26.4.2)
- App：维C QA 包 (vc-staffs)
- 代理：WiFi 手动代理 → Mac IP:PORT
- 拦截：6 个码放排班管控 API

**结果**：mock 命中 `getMafangRosterNewFlowSwitch` callCount=3，录制 257 条真实 API 流量

## 证书安装（iOS）

1. 获取证书：`get_root_ca_cert` MCP 工具
2. 下载到 iPhone：Safari 打开 `http://<Mac-IP>:8888/preflight-ca.pem`
3. 安装描述文件：Settings > 已下载描述文件 > 安装
4. 信任证书：Settings > General > About > Certificate Trust Settings > 开启 Preflight Mock CA

## 限制与已知问题

- 响应体流式捕获不完整（`pipe` 只截取最后 chunk）
- iOS 代理需手动配置（Phase 3 将支持 .mobileconfig 一键安装）
- 动态响应生成未支持（如根据请求参数动态计算日期）
- 不支持 WebSocket 拦截
