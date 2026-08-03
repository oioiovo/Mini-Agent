import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentLoop } from "./loop.js";
import { FakeLlmClient } from "../providers/openai-compatible.js";
import { InMemorySessionStore } from "../session/memory-store.js";
import { InMemoryMemoryStore } from "../memory/store.js";
import { ToolRegistry, defineLocalTool } from "../tools/registry.js";

describe("AgentLoop", () => {
  it("runs a tool then completes", async () => {
    const tools = new ToolRegistry();
    tools.register(
      defineLocalTool({
        name: "add",
        description: "Add two numbers",
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
    const loop = new AgentLoop({
      llm,
      tools,
      sessions,
      memory: new InMemoryMemoryStore(),
      defaultModel: "fake",
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
    const loop = new AgentLoop({
      llm,
      tools,
      sessions,
      defaultModel: "fake",
    });

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
});
