# 快速开始

> 语言：[中文](./getting-started.md) | [English](../en/getting-started.md)

## 前置要求

- Node.js 20+
- pnpm 9+
- Python 3.10+（仅在使用 Python SDK 时需要）
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
```

## 启动 Runtime 服务

```bash
pnpm --filter @mini-agent/server start
# 开发时也可以：
pnpm dev
```

健康检查：`GET http://127.0.0.1:8787/healthz`

## TypeScript 客户端

```bash
pnpm --filter @mini-agent/example-ts-basic start -- "What is 21 * 2?"
```

```ts
import { MiniAgentClient } from "@mini-agent/sdk";

const client = new MiniAgentClient({
  baseUrl: "http://127.0.0.1:8787",
  apiKey: "dev-key",
});

const session = await client.createSession();
for await (const event of client.run({
  sessionId: session.id,
  message: "hello",
})) {
  console.log(event.payload.case, event.payload.value);
}
```

## Python 客户端

```bash
pip install -r examples/py-basic/requirements.txt
set MINI_AGENT_API_KEY=dev-key
python examples/py-basic/main.py "What is 2+2?"
```

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
