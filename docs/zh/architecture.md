# 架构

> 语言：[中文](./architecture.md) | [English](../en/architecture.md)

## 整体形态

Mini-Agent 采用 **单核心 Runtime + 薄客户端**：

1. TypeScript `packages/runtime` 实现 agent loop、工具、MCP、memory、LLM providers。
2. `packages/server` 用 Connect over HTTP 暴露同一能力。默认以 **HTTP/1.1** 监听；Connect 适配器可编解码 Connect / gRPC / gRPC-Web（原生 gRPC 通常还需自行换 HTTP/2）。
3. `@mini-agent/client` 只做传输与类型封装，不复制 loop 逻辑。

```mermaid
flowchart LR
  Client[packages/client] --> Connect[Connect HTTP]
  Connect --> Server[server]
  Server --> Runtime[runtime]
  Runtime --> LLM[LLM Providers]
  Runtime --> Tools[ToolRegistry]
  Runtime --> MCP[McpManager]
  Runtime --> Mem[MemoryStore]
  Runtime --> Sess[SessionStore]
```

## Agent loop

1. `run.started`
2. 可选 `memory.hit`（检索历史 / 长期记忆）
3. 组装 system + history，调用 LLM
4. 若有 tool_calls：可能先发 `message.delta`，再 `tool.started` →（可选 `tool.approval_required` / `tool.result_delta` / `subagent.*`）→ `tool.completed`，写回消息后继续
5. 若无 tool_calls：`message.delta` + `run.completed`
6. 异常或取消：`run.error`

对外 Connect 流事件使用 camelCase `payload.case`（如 `textDelta`、`toolCall`、`toolApprovalRequired`、`toolResultDelta`、`subagentStarted`）；上表为 runtime 内部点分命名。

## 协议

唯一契约：`proto/agent/v1/agent.proto`

- `CreateSession` / `GetSession`
- `RunAgent`（server streaming events）
- `CancelRun`
- `ResolveToolApproval`
- `ListTools`
- `RegisterHttpTool`
- `UpsertMcpServer`
- `UpsertCronJob` / `GetCronJob` / `ListCronJobs` / `DeleteCronJob` / `SetCronJobEnabled`
- `CompactSession`

生成：`pnpm generate` → `packages/shared/src/gen`

## Cron Scheduler

服务端进程内调度：按 cron 表达式直接调用 `agent.run`（不经假 HTTP）。

- 持久化：`MINI_AGENT_DATA_DIR/cron.sqlite`
- 配置文件：默认加载仓库根 `cron.jobs.yaml`（或 `MINI_AGENT_CRON_FILE`）；`source=file` 的任务在启动时与文件同步，`source=api` 不受文件删除影响
- 动态管理：上述 Cron RPC；观测字段 `last_*` / `next_run_at_ms`
- 无头审批：job 级 `auto_approve`，或全局 `MINI_AGENT_AUTO_APPROVE`
- 重叠策略：默认 `skip`（上一次未结束则跳过）

## Memory 分层

| 层级 | 职责 | 默认实现 |
|------|------|----------|
| Working / Session | 多轮消息 | 服务端默认 SQLite（`node:sqlite`，`MINI_AGENT_DATA_DIR`）；亦可内存 |
| Long-term | 跨会话检索 | 内存词袋 token overlap 打分（非 embedding / 向量库） |
| Context Compact | 上下文压缩 | 四层管线（budget → snip → micro → LLM）；见下节 |

## Context Compact

对齐 [s08](https://learn.shareai.run/zh/s08/)「便宜先跑、贵的后跑」：

1. **L3 tool_result_budget**：过大 tool 结果落盘到 `workspace/.mini-agent/tool-results/`
2. **L1 snip_compact**：消息数超限时裁中间（保护 tool_use / tool_result 成对）
3. **L2 micro_compact**：旧 tool 结果占位，保留最近 N 条完整内容
4. **L4 compact_history**：估算 token 超阈值时 LLM 摘要；transcript 写入 `.mini-agent/transcripts/`
5. **reactive**：API 报 context 过长时再压一次（保留短尾）

触发方式：run 内自动、`CompactSession` RPC、内置工具 `compact`。

## 嵌入 vs 网络

- 同进程：直接 `createAgent()` / `createMiniAgentServer({ agent })`
- 跨进程：HTTP Connect 客户端（`@mini-agent/client`）

## 鉴权与限流

- Header：`x-api-key` 或 `Authorization: Bearer <key>`
- 未配置 `MINI_AGENT_API_KEY` 时不鉴权
- 内存滑动窗口限流（默认 60s / 120 req / key）
