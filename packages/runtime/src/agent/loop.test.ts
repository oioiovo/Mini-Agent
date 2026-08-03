import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentLoop } from "./loop.js";
import { FakeLlmClient } from "../providers/openai-compatible.js";
import { InMemorySessionStore } from "../session/memory-store.js";
import { InMemoryMemoryStore } from "../memory/store.js";
import { ApprovalBroker } from "../tools/approval.js";
import { ToolPolicy } from "../tools/policy.js";
import { ToolRegistry, defineLocalTool } from "../tools/registry.js";

function createLoop(overrides: {
  llm: FakeLlmClient;
  tools: ToolRegistry;
  sessions: InMemorySessionStore;
  memory?: InMemoryMemoryStore;
  policy?: ToolPolicy;
  approvals?: ApprovalBroker;
}) {
  return new AgentLoop({
    llm: overrides.llm,
    tools: overrides.tools,
    sessions: overrides.sessions,
    memory: overrides.memory,
    defaultModel: "fake",
    policy: overrides.policy ?? new ToolPolicy({ autoApprove: true }),
    approvals: overrides.approvals ?? new ApprovalBroker(),
  });
}

describe("AgentLoop", () => {
  it("runs a tool then completes", async () => {
    const tools = new ToolRegistry();
    tools.register(
      defineLocalTool({
        name: "add",
        description: "Add two numbers",
        risk: "read",
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "number" },
            b: { type: "number" },
          },
          required: ["a", "b"],
        },
        execute: ({ a, b }) => ({ sum: Number(a) + Number(b) }),
      }),
    );

    let step = 0;
    const llm = new FakeLlmClient(async () => {
      step += 1;
      if (step === 1) {
        return {
          finishReason: "tool_calls",
          message: {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call_1",
                name: "add",
                arguments: JSON.stringify({ a: 2, b: 3 }),
              },
            ],
          },
        };
      }
      return {
        finishReason: "stop",
        message: {
          role: "assistant",
          content: "The sum is 5.",
        },
      };
    });

    const sessions = new InMemorySessionStore();
    const session = await sessions.create({});
    const loop = createLoop({
      llm,
      tools,
      sessions,
      memory: new InMemoryMemoryStore(),
    });

    const events = [];
    for await (const event of loop.run({ sessionId: session.id, message: "2+3?" })) {
      events.push(event.type);
    }

    assert.deepEqual(events, [
      "run.started",
      "tool.started",
      "tool.completed",
      "message.delta",
      "run.completed",
    ]);
  });

  it("isolates unknown tool errors", async () => {
    const tools = new ToolRegistry();
    let step = 0;
    const llm = new FakeLlmClient(async () => {
      step += 1;
      if (step === 1) {
        return {
          finishReason: "tool_calls",
          message: {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call_x",
                name: "missing",
                arguments: "{}",
              },
            ],
          },
        };
      }
      return {
        finishReason: "stop",
        message: { role: "assistant", content: "Tool missing failed." },
      };
    });

    const sessions = new InMemorySessionStore();
    const session = await sessions.create({});
    const loop = createLoop({ llm, tools, sessions });

    const completed = [];
    for await (const event of loop.run({ sessionId: session.id, message: "go" })) {
      if (event.type === "tool.completed") completed.push(event);
      if (event.type === "run.completed") {
        assert.equal(event.finalText, "Tool missing failed.");
      }
    }
    assert.equal(completed.length, 1);
    assert.equal(completed[0]?.isError, true);
  });

  it("emits approval_required then continues after approve", async () => {
    const tools = new ToolRegistry();
    tools.register(
      defineLocalTool({
        name: "write_file",
        description: "Write",
        risk: "write",
        requiresApproval: true,
        sideEffect: true,
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
        execute: () => ({ written: true }),
      }),
    );

    let step = 0;
    const llm = new FakeLlmClient(async () => {
      step += 1;
      if (step === 1) {
        return {
          finishReason: "tool_calls",
          message: {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "w1",
                name: "write_file",
                arguments: JSON.stringify({ path: "a.txt", content: "hi" }),
              },
            ],
          },
        };
      }
      return {
        finishReason: "stop",
        message: { role: "assistant", content: "wrote file" },
      };
    });

    const sessions = new InMemorySessionStore();
    const session = await sessions.create({});
    const approvals = new ApprovalBroker();
    const loop = createLoop({
      llm,
      tools,
      sessions,
      policy: new ToolPolicy({ autoApprove: false }),
      approvals,
    });

    const events: string[] = [];
    const run = loop.run({ sessionId: session.id, message: "write" });
    const consume = (async () => {
      for await (const event of run) {
        events.push(event.type);
        if (event.type === "tool.approval_required") {
          const result = loop.resolveApproval(event.runId, event.approvalId, "approve");
          assert.equal(result.ok, true);
        }
      }
    })();
    await consume;

    assert.deepEqual(events, [
      "run.started",
      "tool.approval_required",
      "tool.started",
      "tool.completed",
      "message.delta",
      "run.completed",
    ]);
  });

  it("emits tool.result_delta chunks", async () => {
    const tools = new ToolRegistry();
    tools.register(
      defineLocalTool({
        name: "streamy",
        description: "Streams",
        risk: "read",
        execute: (_args, ctx) => {
          ctx.emitDelta("hello ");
          ctx.emitDelta("world");
          return { ok: true };
        },
      }),
    );

    let step = 0;
    const llm = new FakeLlmClient(async () => {
      step += 1;
      if (step === 1) {
        return {
          finishReason: "tool_calls",
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "s1", name: "streamy", arguments: "{}" }],
          },
        };
      }
      return {
        finishReason: "stop",
        message: { role: "assistant", content: "done" },
      };
    });

    const sessions = new InMemorySessionStore();
    const session = await sessions.create({});
    const loop = createLoop({ llm, tools, sessions });
    const events = [];
    const deltas = [];
    for await (const event of loop.run({ sessionId: session.id, message: "stream" })) {
      events.push(event.type);
      if (event.type === "tool.result_delta") deltas.push(event.chunk);
    }
    assert.deepEqual(deltas, ["hello ", "world"]);
    assert.ok(events.includes("tool.result_delta"));
    assert.ok(events.indexOf("tool.result_delta") < events.indexOf("tool.completed"));
  });

  it("runs auto-allow read tools in parallel", async () => {
    const tools = new ToolRegistry();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    tools.register(
      defineLocalTool({
        name: "slow_a",
        description: "A",
        risk: "read",
        execute: async () => {
          await sleep(80);
          return { name: "a" };
        },
      }),
    );
    tools.register(
      defineLocalTool({
        name: "slow_b",
        description: "B",
        risk: "read",
        execute: async () => {
          await sleep(80);
          return { name: "b" };
        },
      }),
    );

    let step = 0;
    const llm = new FakeLlmClient(async () => {
      step += 1;
      if (step === 1) {
        return {
          finishReason: "tool_calls",
          message: {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "a1", name: "slow_a", arguments: "{}" },
              { id: "b1", name: "slow_b", arguments: "{}" },
            ],
          },
        };
      }
      return {
        finishReason: "stop",
        message: { role: "assistant", content: "both done" },
      };
    });

    const sessions = new InMemorySessionStore();
    const session = await sessions.create({});
    const loop = createLoop({ llm, tools, sessions });
    const started = Date.now();
    for await (const _event of loop.run({ sessionId: session.id, message: "go" })) {
      // drain
    }
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 150, `expected parallel (~80ms), got ${elapsed}ms`);
  });
});
