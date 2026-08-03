# Mini-Agent

> Languages: [中文](../README.md) | [English](README.en.md)

A TypeScript single-core Agent Runtime that exposes a streaming API over Connect HTTP (HTTP/1.1 by default). Use the thin `@mini-agent/client`, or embed `@mini-agent/runtime` in-process.

## Features

- Agent loop (multi-step tool calls, cancellation, timeouts, max steps)
- Local / HTTP / MCP tools (including `todo_write` / `todo_read`, async read-only `run_subagent`)
- Session (SQLite by default, in-memory available) + Memory (bag-of-words retrieval / summarization)
- OpenAI-compatible LLM Provider
- Connect HTTP API + API Key auth + basic rate limiting
- `@mini-agent/client` (Connect thin client)

## Quick start

```bash
pnpm install
pnpm generate
pnpm build
cp .env.example .env   # set OPENAI_API_KEY
pnpm --filter @mini-agent/server start
```

In another terminal:

```bash
pnpm --filter @mini-agent/example-ts-basic start
```

## Repository layout

```text
proto/agent/v1          # single contract
packages/runtime        # Agent loop / tools / mcp / memory / providers
packages/server         # Connect HTTP server (HTTP/1.1 by default)
packages/shared         # generated protobuf / Connect types
packages/testkit        # unified tests (YAML + hooks)
packages/client         # Connect thin client (@mini-agent/client)
examples/ts-basic
docs/
  zh/                   # Chinese docs
  en/                   # English docs
  README.en.md          # this file
```

## Embed in-process (TypeScript)

```ts
import { createAgent, defineLocalTool } from "@mini-agent/runtime";

const agent = await createAgent({
  tools: [
    defineLocalTool({
      name: "echo",
      description: "Echo text",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      execute: ({ text }) => ({ text }),
    }),
  ],
});

const session = await agent.createSession();
for await (const event of agent.run({ sessionId: session.id, message: "hi" })) {
  console.log(event);
}
```

## Docs

- [Getting Started](en/getting-started.md) · [快速开始](zh/getting-started.md)
- [Architecture](en/architecture.md) · [架构](zh/architecture.md)
- [Docs index](README.md)

## Development

```bash
pnpm generate
pnpm test       # build + residual node:test + testkit unit,e2e (FakeLlm)
pnpm test:unit
pnpm test:e2e
pnpm test:live  # requires running server + MINI_AGENT_LIVE_TEST=1
pnpm build
```

Unified harness: `packages/testkit` (YAML cases + optional TS hooks). Reports land in `artifacts/test-runs/<ts>/report.md` and `report.json`.

```bash
pnpm testkit -- --list
pnpm testkit -- --mode live --only calculator
$env:MINI_AGENT_LIVE_TEST=1
pnpm test:live -- --only write,read
```
