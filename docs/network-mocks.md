# Network Mock — 架构与实践

## 概述

Preflight 的网络 Mock 功能通过本地 MITM HTTPS 代理拦截 Android 请求，根据预定义规则返回 mock 响应，支持 Android 模拟器和已安装 WireGuard 客户端的真机。未命中的请求继续透传到真实服务。

## 架构

```
┌──────────────┐     ┌─────────────────┐     ┌──────────────┐
│  Android     │────▶│  NetworkMock    │────▶│  Real API     │
│  Emulator /  │     │  Server (MITM)  │     │  Servers      │
│  WireGuard   │     │  + WireGuard    │     │               │
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

### WireGuardMockServer (`src/mcp/network-mocks/WireGuardMockServer.ts`)

mitmproxy WireGuard userspace server，负责：

- **WireGuard 接入**：生成 profile，设备通过 VPN 隧道访问本机服务
- **选择性 MITM**：仅对 `hostRegex` 命中的 SNI 解密，其他连接加密透传
- **规则匹配**：`hostRegex` → `pathPattern`/`pathRegex` → `queryParams`/`method` → `callIndex`
- **静态响应**：返回 `responses`，当前不支持 inline handler 和录制

### NetworkMockService (`src/mcp/network-mocks/NetworkMockService.ts`)

生命周期管理器：

- `start(config)` — 启动本地 mitmproxy WireGuard 服务并启停 Android 隧道
- `stop()` — 停止服务器 + 关闭 WireGuard 隧道
- `getStats()` — 返回每规则的调用统计
- `updateRules(rules)` — 热更新规则，不中断服务
- `exportRecordedRules()` — WireGuard 模式暂不支持录制，返回空规则

### device-ca (`src/mcp/network-mocks/device-ca.ts`)

CA 自动安装：`adb root` + 推送证书到 `/data/misc/user/0/cacerts-added/<hash>.0`（Android 用户信任存储），幂等操作。要求模拟器使用可 root 的 AOSP 镜像（非 Play Store 镜像）。

### device-proxy (`src/mcp/network-mocks/device-proxy.ts`)

设备级代理配置由 WireGuard Android 隧道接管，不修改 `http_proxy`。

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
}
```

`responses` 与 `handler` 互斥；两者均省略则规则仅参与录制（record-only）。

### hostRegex 锚定

`hostRegex` 必须锚定，否则会解密（MITM）非目标主机：未锚定的 `example\.com` 会同时命中 `evil-example.com` 与 `example.com.attacker.net`。

- 以 `$` 结尾，并用 `\.` 转义点号，例如 `api\.example\.com$`。
- 需匹配子域时用点边界 `(^|\.)example\.com$`，避免命中 `evil-example.com`。
- 校验会拒绝明显的全匹配模式，但无法穷举所有不安全写法，请自行核实锚定。

## MCP 工具

| 工具 | 说明 |
|------|------|
| `start_network_mocks` | 启动 WireGuard mock，自动安装 CA 并配置设备隧道 |
| `stop_network_mocks` | 停止代理并关闭 WireGuard 隧道 |
| `get_network_mock_status` | 查询各规则调用次数 |
| `update_network_mock_rules` | 热更新规则（运行时动态修改） |
| `get_root_ca_cert` | 导出 Root CA 证书（PEM），直接从内存读取 |
| `start_recording` / `stop_recording` / `export_recorded_rules` | WireGuard transport 暂不支持录制 |

## 标准工作流

### 流程 A：从零开始 mock 一个新 API

```
1. start_network_mocks(rules=[])         — 自动安装 CA，启动 WireGuard 隧道
2. 在 app 中操作目标流程，确认需要 mock 的 API
3. update_network_mock_rules()           — 热更新，不重启
4. 重新操作 app → 验证 mock 命中
```

### 流程 B：使用已有 mock 规则跑测试

```
1. run_flow(visualFlow with networkMocks)  →  自动启动 mock + CA 安装
2. 测试运行，mock 自动拦截匹配的 API
3. 测试结束自动停止 mock
```

## 真机 WireGuard 模式

`start_network_mocks` 现在始终使用 WireGuard transport，Preflight 会：

1. 启动本机 `mitmdump`/`mitmweb --mode wireguard`，生成稳定的 WireGuard server/client key；
2. 生成 profile 并 push 到手机的 `Download` 目录；
3. 通过 WireGuard Android 的远程控制 intent 启停指定 tunnel，不修改 Android 的 `http_proxy`；
4. 只对 `hostRegex` 命中的 SNI 做 TLS MITM，其他域名使用加密透传；命中 host 但未命中 path 的请求也透传。

首次使用需要在手机 WireGuard 中导入 `start_network_mocks` 返回的 profile，并在 WireGuard 高级设置开启远程控制；Android VPN 授权和 CA 信任仍是系统一次性授权。该模式需要 Mac 上可执行的 `mitmdump` 或 `mitmweb`，也可用 `PREFLIGHT_MITMPROXY_BIN` 指定绝对路径。WireGuard 模式当前支持静态 `responses`，不支持 `handler`。

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
- 真机：WireGuard Android + mitmproxy WireGuard 模式，CA 手动信任后 HTTPS mock 与未命中透传均可用
- 拦截：多个 API 路径，mock 命中统计正常

## 限制与已知问题

- 仅支持 Android；iOS 需手动配置代理和证书，暂不支持自动化
- 需要可 root 的模拟器镜像（非 Play Store 版本）
- WireGuard 模式当前仅支持静态 `responses`，不支持 `handler` 和录制
- 不支持 WebSocket 拦截
