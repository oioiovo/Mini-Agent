# Mini-Agent

> 语言：[中文](README.md) | [English](docs/README.en.md)

TypeScript 单核心 Agent Runtime，通过 Connect（HTTP，默认同时兼容 gRPC）对外提供流式 API；TS / Python 等语言使用薄客户端接入。

## 功能

- Agent loop（多步工具调用、取消、超时、最大步数）
- Local / HTTP / MCP 工具（含 `todo_write` / `todo_read`、异步只读 `run_subagent`）
- Session（内存或 SQLite）+ Memory（检索 / 摘要）
- OpenAI-compatible LLM Provider
- Connect HTTP API + API Key 鉴权 + 基础限流
- `@mini-agent/sdk`（TypeScript）与 `mini-agent`（Python）薄客户端

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

Python：

```bash
pip install -r examples/py-basic/requirements.txt
python examples/py-basic/main.py
```

## 仓库结构

```text
proto/agent/v1          # 唯一契约
packages/runtime        # Agent loop / tools / mcp / memory / providers
packages/server         # Connect HTTP 服务（gRPC 默认开启）
packages/testkit        # 统一测试（YAML + hooks，unit/e2e/live）
packages/shared         # 生成的 protobuf / Connect 类型
packages/sdk-ts         # TypeScript 薄客户端
packages/sdk-py         # Python 薄客户端
examples/ts-basic
examples/py-basic
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

残留 `node:test`：policy、paths、CLI smoke（非 agent 声明式场景）。
