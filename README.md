# Codex DeepSeek V4 Proxy

Minimal local proxy that translates Codex CLI's Responses API requests into DeepSeek Chat Completions format and returns properly formatted Responses API responses.

## Quick Start

```powershell
codex-dsf "只回复 ok"    # DeepSeek V4 Flash
codex-ds  "只回复 ok"    # DeepSeek V4 Pro
```

## Architecture

```
Codex CLI  ──(Responses API)──▸  Proxy :11435  ──(Chat Completions)──▸  DeepSeek API
                                    │
                            Pseudo-streaming:
                            non-stream to DeepSeek,
                            SSE wrap to Codex
```

## Setup

1. Put your DeepSeek API key in `.env`:
   ```
   DEEPSEEK_API_KEY=sk-your-key-here
   ```
2. Set the Codex dummy key (one-time):
   ```powershell
   setx CODEX_DS_PROXY_KEY "local-dummy"
   ```

## Manual Start

```powershell
cd <project-dir>
npm start
```

## Logs

```powershell
Get-Content <project-dir>\logs\proxy.log -Tail 50 -Wait
```

## Stop Proxy

```powershell
Get-NetTCPConnection -LocalPort 11435 | Select-Object OwningProcess
taskkill /PID <PID> /F
```

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check |
| POST | `/v1/responses` | Responses API |
| POST | `/responses` | Responses API (no prefix) |

## Models

- `deepseek-v4-pro` via `codex-ds` / `codex --profile ds-pro`
- `deepseek-v4-flash` via `codex-dsf` / `codex --profile ds-flash`

## Current Capabilities

| Feature | Status |
|---|---|
| Simple text chat | Working |
| Pseudo-streaming SSE | Working |
| Real streaming | Not yet (using non-stream to DeepSeek) |
| Tool calls | Converted but may be unstable |
| Images | Not supported |
| Web search | Not supported |

## Known Limitations

- Multi-turn tool call conversations may be unstable
- Complex tool schemas may not convert correctly
- `reasoning_effort` is mapped: low/medium → high, high → high, xhigh/max → max

## Troubleshooting

1. Proxy not starting — check `logs/proxy.log`, verify port 11435 is free
2. `DEEPSEEK_API_KEY` not found — restart PowerShell after setting
3. DeepSeek 400 error — check debug logs for converted body format
4. `stream closed before completion` — verify `response.completed` in logs
