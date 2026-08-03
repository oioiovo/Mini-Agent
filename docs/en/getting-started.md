# Getting Started

> Languages: [中文](../zh/getting-started.md) | [English](./getting-started.md)

## Prerequisites

- Node.js 20+
- pnpm 9+
- Python 3.10+ (only required when using the Python SDK)
- OpenAI-compatible API Key

## Install

```bash
pnpm install
pnpm generate
pnpm build
cp .env.example .env
```

Configure `.env`:

```bash
OPENAI_API_KEY=sk-...
MINI_AGENT_API_KEY=dev-key
MINI_AGENT_PORT=8787
MINI_AGENT_WORKSPACE=./workspace
# Local debug only — keep false in production
MINI_AGENT_AUTO_APPROVE=false
```

## Start the runtime server

```bash
pnpm --filter @mini-agent/server start
# or during development:
pnpm dev
```

Health check: `GET http://127.0.0.1:8787/healthz`

Builtin tools: `now`, `calculator`, `list_dir`, `read_file`, `write_file`, `http_request`.  
`write_file` / `http_request` require approval unless `MINI_AGENT_AUTO_APPROVE=true`.

Tool execution:
- Tools may push `toolResultDelta` via `emitDelta` (client observability; the model still receives the final full `toolResult`)
- Auto-allowed `risk=read` tools in the same step run in parallel; approval / write / network / exec stay serial

## TypeScript client

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

## Testing (testkit)

Agent cases live in `packages/testkit/cases/*.yaml` with optional hooks under `packages/testkit/hooks/`.

```bash
pnpm test
pnpm testkit -- --list
set MINI_AGENT_LIVE_TEST=1
pnpm test:live -- --only calculator
```

Reports: `artifacts/test-runs/<timestamp>/report.md` and `report.json`.

## Python client

```bash
pip install -r examples/py-basic/requirements.txt
set MINI_AGENT_API_KEY=dev-key
python examples/py-basic/main.py "What is 2+2?"
```

## Register an HTTP tool

Host applications can register business capabilities with the Runtime as HTTP callbacks:

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

The Runtime will `POST` JSON: `{ arguments, sessionId, runId }`.

## MCP

```ts
await client.upsertMcpServer({
  name: "filesystem",
  transport: "stdio",
  endpoint: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
});
```

Tool names become: `mcp.filesystem.<tool>`.

## gRPC

The Connect router enables Connect / gRPC / gRPC-Web by default. The same proto can be used with gRPC clients (HTTP/2 recommended).
