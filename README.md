# Mini-Agent

> 语言：[中文](README.md) | [English](docs/README.en.md)

TypeScript 单核心 Agent Runtime，通过 Connect over HTTP 对外提供流式 API（默认 HTTP/1.1）；可用 `@mini-agent/client` 薄客户端接入，或同进程直接嵌入 `@mini-agent/runtime`。

## 功能

- Agent loop（多步工具调用、取消、超时、最大步数）
- Local / HTTP / MCP 工具（含 `todo_write` / `todo_read`、异步只读 `run_subagent`）
- Session（默认 SQLite，亦可内存）+ Durable File Memory（`MEMORY.md` + Markdown；自动提取 + `memory_*` 工具）
- OpenAI-compatible LLM Provider
- Connect HTTP API + API Key 鉴权 + 基础限流
- `@mini-agent/client`（Connect 薄客户端）
- Cron Scheduler（配置文件 + proto 动态管理，定时触发 Agent run）
- Context Compact（四层上下文压缩：budget / snip / micro / LLM）
- System Prompt 运行时组装（identity / tools / workspace / memory）
- Error Recovery（截断续写、reactive compact、429/529 退避与备用模型）

## 快速开始

```bash
pnpm install
pnpm generate
pnpm build
cp .env.example .env   # 填入 OPENAI_API_KEY
pnpm --filter @mini-agent/server start
```

另开终端：

```bash
pnpm --filter @mini-agent/example-ts-basic start
```

## 仓库结构

```text
proto/agent/v1          # 唯一契约
packages/runtime        # Agent loop / tools / mcp / memory / providers
packages/server         # Connect HTTP 服务（默认 HTTP/1.1）
packages/testkit        # 统一测试（YAML + hooks，unit/e2e/live）
packages/shared         # 生成的 protobuf / Connect 类型
packages/client         # Connect 薄客户端（@mini-agent/client）
examples/ts-basic
docs/
  zh/                   # 中文文档
  en/                   # English docs
```

## 嵌入使用（同进程 TypeScript）

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

## 文档

- [快速开始](docs/zh/getting-started.md) · [Getting Started](docs/en/getting-started.md)
- [架构](docs/zh/architecture.md) · [Architecture](docs/en/architecture.md)
- [文档索引](docs/README.md)

## 开发

```bash
pnpm generate   # buf generate
pnpm test       # build + policy/paths/CLI smoke + testkit unit,e2e（FakeLlm）
pnpm test:unit  # testkit --mode unit
pnpm test:e2e   # testkit --mode e2e
pnpm test:live  # testkit --mode live（需已启动 server + MINI_AGENT_LIVE_TEST=1）
pnpm build
```

统一测试包 [`packages/testkit`](packages/testkit)：YAML 用例 + 可选 TS hooks，三种 mode 共用；每次运行写出 `artifacts/test-runs/<ts>/report.md`（人类）与 `report.json`（AI），以及 `logs/`。

```bash
pnpm testkit -- --list
pnpm testkit -- --mode unit,e2e
pnpm testkit -- --mode live --only calculator

$env:MINI_AGENT_LIVE_TEST=1
pnpm test:live
pnpm test:live -- --only write,read
```

残留 `node:test`：runtime（policy / todo / subagent）与 server（paths / CLI smoke）。
