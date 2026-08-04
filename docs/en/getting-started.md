# Getting Started

> Languages: [中文](../zh/getting-started.md) | [English](./getting-started.md)

## Prerequisites

- Node.js 20+
- pnpm 9+
- OpenAI-compatible API Key

## Install

```bash
pnpm install
pnpm generate
pnpm build
cp .env.example .env
```

Configure `.env` (full template: repo-root `.env.example`):

```bash
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
MINI_AGENT_API_KEY=dev-key
MINI_AGENT_PORT=8787
# Relative paths resolve from the monorepo root
MINI_AGENT_DATA_DIR=./data
MINI_AGENT_WORKSPACE=./workspace
# Local debug only — keep false in production
MINI_AGENT_AUTO_APPROVE=false
# Allow http_request to private/LAN hosts
MINI_AGENT_HTTP_ALLOW_PRIVATE=false
# Optional cron jobs file (loads ./cron.jobs.yaml by default when present)
# MINI_AGENT_CRON_FILE=./cron.jobs.yaml
```

## Start the runtime server

```bash
pnpm --filter @mini-agent/server start
# or during development:
pnpm dev
```

Health check: `GET http://127.0.0.1:8787/healthz`

Builtin tools: `now`, `calculator`, `todo_write`, `todo_read`, `list_dir`, `read_file`, `write_file`, `http_request`, `run_subagent`, `compact`, `memory_write`, `memory_read`.
`write_file` / `http_request` require approval unless `MINI_AGENT_AUTO_APPROVE=true`.  
`todo_write` / `todo_read` persist a per-session task list under workspace `.mini-agent/todos/<sessionId>.json` (no approval).  
`memory_write` / `memory_read` read/write the durable memory directory (default `workspace/.mini-agent/memory/`, override with `MINI_AGENT_MEMORY_DIR`) without approval; runs also auto-extract memories via LLM. See [Architecture · Memory](./architecture.md#memory-layers).  
`run_subagent` starts a read-only async child agent (isolated session). The parent run stream emits `subagentStarted` / `subagentProgress` / `subagentCompleted`; the tool result contains the child's final text. Default child tools: `now`, `calculator`, `list_dir`, `read_file`, `todo_*` (no nesting).

Tool execution:
- Tools may push `toolResultDelta` via `emitDelta` (client observability; the model still receives the final full `toolResult`)
- Auto-allowed `risk=read` tools in the same step run in parallel; approval / write / network / exec stay serial

## TypeScript client

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

## Testing (testkit)

Agent cases live in `packages/testkit/cases/*.yaml` with optional hooks under `packages/testkit/hooks/`.

```bash
pnpm test                 # FakeLlm unit + e2e + residual runtime/server node:test
pnpm testkit -- --list
# live needs a running server plus MINI_AGENT_LIVE_TEST=1 (optional MINI_AGENT_URL / MINI_AGENT_API_KEY)
set MINI_AGENT_LIVE_TEST=1
pnpm test:live -- --only calculator
```

Reports: `artifacts/test-runs/<timestamp>/report.md` and `report.json`.

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

Supports `stdio` / `sse` / `http` transports. Example (stdio):

```ts
await client.upsertMcpServer({
  name: "filesystem",
  transport: "stdio",
  endpoint: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
});
```

Tool names become: `mcp.filesystem.<tool>`.

## Cron jobs

Copy [`cron.jobs.example.yaml`](../../cron.jobs.example.yaml) to repo-root `cron.jobs.yaml`, or set `MINI_AGENT_CRON_FILE`. You can also manage jobs via the client:

```ts
await client.upsertCronJob({
  id: "morning-digest",
  cron: "0 9 * * *",
  timezone: "Asia/Shanghai",
  message: "Summarize workspace changes and open todos.",
  sessionMode: "sticky",
  autoApprove: true,
});
const jobs = await client.listCronJobs();
```

For unattended runs, set job `autoApprove: true` and/or `MINI_AGENT_AUTO_APPROVE=true`. See [Architecture · Cron Scheduler](./architecture.md#cron-scheduler).

## Context Compact

Long sessions are compacted automatically (budget → snip → micro → LLM). You can also trigger manually:

```ts
await client.compactSession({ sessionId: session.id, forceLlm: true });
```

The model can call the builtin `compact` tool. See [Architecture · Context Compact](./architecture.md#context-compact).

## Protocol & transport

The default server serves Connect over HTTP/1.1 (with gRPC-Web-compatible codecs). The same proto can be used with gRPC clients, but that usually requires an HTTP/2 listener.
