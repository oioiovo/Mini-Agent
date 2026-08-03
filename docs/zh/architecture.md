# 架构

> 语言：[中文](./architecture.md) | [English](../en/architecture.md)

## 整体形态

Mini-Agent 采用 **单核心 Runtime + 薄客户端**：

1. TypeScript `packages/runtime` 实现 agent loop、工具、MCP、memory、LLM providers。
2. `packages/server` 用 Connect over HTTP 暴露同一能力；默认同时兼容 gRPC。
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
4. 若有 tool_calls：`tool.started` → 执行 → `tool.completed`，写回消息后继续
5. 否则 `message.delta` + `run.completed`
6. 异常或取消：`run.error`

## 协议

唯一契约：`proto/agent/v1/agent.proto`

- `CreateSession` / `GetSession`
- `RunAgent`（server streaming events）
- `CancelRun`
- `ListTools`
- `RegisterHttpTool`
- `UpsertMcpServer`

生成：`pnpm generate` → `packages/shared/src/gen`

## Memory 分层

| 层级 | 职责 | 默认实现 |
|------|------|----------|
| Working / Session | 多轮消息 | SQLite (`node:sqlite`) 或内存 |
| Long-term | 跨会话检索 | 内存向量（词袋相似度） |
| Summary | 超长历史压缩 | 截断 + system summary |

## 嵌入 vs 网络

- 同进程：直接 `createAgent()` / `createMiniAgentServer({ agent })`
- 跨进程：HTTP Connect 客户端（`@mini-agent/client`）

## 鉴权与限流

- Header：`x-api-key` 或 `Authorization: Bearer <key>`
- 内存滑动窗口限流（默认 60s / 120 req / key）
