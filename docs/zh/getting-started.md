# 快速开始

> 语言：[中文](./getting-started.md) | [English](../en/getting-started.md)

## 前置要求

- Node.js 20+
- pnpm 9+
- OpenAI-compatible API Key

## 安装

```bash
pnpm install
pnpm generate
pnpm build
cp .env.example .env
```

在 `.env` 中设置：

```bash
OPENAI_API_KEY=sk-...
MINI_AGENT_API_KEY=dev-key
MINI_AGENT_PORT=8787
MINI_AGENT_WORKSPACE=./workspace
# 本地调试可打开自动审批（生产请保持 false）
MINI_AGENT_AUTO_APPROVE=false
```

## 启动 Runtime 服务

```bash
pnpm --filter @mini-agent/server start
# 开发时也可以：
pnpm dev
```

健康检查：`GET http://127.0.0.1:8787/healthz`

默认内置工具：`now`、`calculator`、`todo_write`、`todo_read`、`list_dir`、`read_file`、`write_file`、`http_request`、`run_subagent`。  
其中 `write_file` / `http_request` 默认需要审批（除非 `MINI_AGENT_AUTO_APPROVE=true`）。
`todo_write` / `todo_read` 按 session 将任务列表存到 workspace `.mini-agent/todos/<sessionId>.json`，免审批。
`run_subagent` 启动只读隔离的异步子 Agent（独立 session）；父 run 流会收到 `subagentStarted` / `subagentProgress` / `subagentCompleted` 事件，工具结果返回子 Agent 最终文本。子 Agent 默认工具：`now`、`calculator`、`list_dir`、`read_file`、`todo_*`（不可再嵌套）。

工具执行规则：
- 工具可通过 `emitDelta` 推送 `toolResultDelta`（客户端观察用；发给模型的仍是最终完整 `toolResult`）
- 同一步内 **自动放行且 risk=read** 的工具会并行执行；需审批 / write / network / exec 仍串行

## TypeScript 客户端

```bash
pnpm --filter @mini-agent/example-ts-basic start -- "What is 21 * 2?"
```

```ts
import { MiniAgentClient } from "@mini-agent/client";

const client = new MiniAgentClient({
  baseUrl: "http://127.0.0.1:8787",
  apiKey: "dev-key",
});

const session = await client.createSession();
for await (const event of client.run({
  sessionId: session.id,
  message: "hello",
})) {
  if (event.payload.case === "toolApprovalRequired") {
    await client.resolveToolApproval({
      runId: event.runId,
      approvalId: event.payload.value.approvalId,
      decision: "approve", // or "deny"
    });
  }
  console.log(event.payload.case, event.payload.value);
}
```

## 测试（testkit）

Agent 行为用例在 `packages/testkit/cases/*.yaml`，复杂断言放在 `packages/testkit/hooks/`。

```bash
pnpm test                 # FakeLlm：unit + e2e + 残余 node:test
pnpm testkit -- --list
$env:MINI_AGENT_LIVE_TEST=1
pnpm test:live -- --only calculator
```

报告目录：`artifacts/test-runs/<timestamp>/report.md` 与 `report.json`。

## 注册 HTTP 工具

宿主项目可以把业务能力以 HTTP 回调形式注册进 Runtime：

```ts
await client.registerHttpTool({
  name: "crm.lookup",
  description: "Lookup a CRM account",
  url: "https://my-app.example/tools/crm-lookup",
  inputSchema: {
    type: "object",
    properties: { accountId: { type: "string" } },
    required: ["accountId"],
  },
});
```

Runtime 会 `POST` JSON：`{ arguments, sessionId, runId }`。

## MCP

```ts
await client.upsertMcpServer({
  name: "filesystem",
  transport: "stdio",
  endpoint: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
});
```

工具名会变成：`mcp.filesystem.<tool>`。

## gRPC

Connect router 默认同时开启 Connect / gRPC / gRPC-Web。同一套 proto 可用 gRPC 客户端对接（建议 HTTP/2）。
