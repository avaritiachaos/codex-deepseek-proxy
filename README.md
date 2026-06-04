# Codex DeepSeek V4 Proxy

本地 OpenAI Responses API 兼容代理，将 Codex CLI 请求转发到 DeepSeek 官方 API。

## 快速开始

```powershell
# 一键启动 DeepSeek V4 Pro
codex-ds "只回复 ok"

# 一键启动 DeepSeek V4 Flash
codex-dsf "只回复 ok"
```

## 架构

```
Codex CLI  ──(Responses API)──▸  本地代理 :11435  ──(Chat Completions)──▸  DeepSeek API
```

- 代理监听 `127.0.0.1:11435`
- 接受 OpenAI Responses API 格式请求 (`POST /v1/responses`)
- 转换为 Chat Completions 格式转发至 `https://api.deepseek.com`
- 支持 SSE 流式响应

## 手动启动

```powershell
cd <project-dir>
npm start
```

## 查看日志

```powershell
Get-Content <project-dir>\logs\proxy.log -Tail 50 -Wait
```

## 关闭代理

```powershell
# 找到进程
Get-Process -Name node | Where-Object { $_.Path -like '*codex-deepseek-proxy*' }
# 或者直接
Get-NetTCPConnection -LocalPort 11435 | Select-Object OwningProcess
taskkill /PID <PID> /F
```

## 环境变量

| 变量名 | 说明 |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek API 密钥（必须，不会被代理写入任何文件） |
| `CODEX_DS_PROXY_KEY` | Codex 连接代理用的 dummy key，值为 `local-dummy` |
| `PROXY_PORT` | 代理端口（可选，默认 11435） |

## API 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| POST | `/v1/responses` | Responses API 入口 |
| POST | `/responses` | Responses API 入口（无 v1 前缀） |

## 支持的模型

- `deepseek-v4-pro` — 通过 `codex-ds` 或 `codex --profile ds-pro`
- `deepseek-v4-flash` — 通过 `codex-dsf` 或 `codex --profile ds-flash`

## 已知限制与不稳定功能

### Tool Calls（函数调用）
- 基本的单轮 tool call 可以工作
- **多轮 tool call 对话**（Codex 反复调用工具再回复）可能不稳定
- 复杂的并行 tool calls 未经充分测试

### Codex 功能兼容性
- 简单对话和代码生成：**正常**
- 文件读写操作（通过 tool calls）：**可能不稳定**
- Codex 的沙盒命令执行：**依赖 DeepSeek tool call 质量**
- `reasoning_effort` / `thinking` 参数：DeepSeek V4 的 Chat Completions API 不一定支持此参数，代理会忽略
- 图片输入：不支持
- Web search tool：不支持

### 流式响应
- SSE 流式输出已实现，基本文本流正常工作
- 极端长文本的流式响应可能因 DeepSeek API 行为而偶尔中断

## 故障排查

1. **代理没起来** — 检查 `logs/proxy.log`，确认端口 11435 未被占用
2. **DEEPSEEK_API_KEY 没生效** — 设置后需重新打开 PowerShell 窗口
3. **Codex 请求格式不兼容** — 查看日志中记录的请求体
4. **DeepSeek 模型名错误** — 确认 DeepSeek API 支持你使用的模型名
5. **SSE 流格式不兼容** — 检查日志中的流式事件序列
