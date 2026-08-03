import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createAgent,
  defineLocalTool,
  FakeLlmClient,
} from "@mini-agent/runtime";
import { MiniAgentClient } from "@mini-agent/sdk";
import { createMiniAgentServer } from "./server.js";

describe("server e2e", () => {
  it("streams a tool-using run over Connect HTTP", async () => {
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
                id: "c1",
                name: "echo",
                arguments: JSON.stringify({ text: "pong" }),
              },
            ],
          },
        };
      }
      return {
        finishReason: "stop",
        message: { role: "assistant", content: "pong" },
      };
    });

    const agent = await createAgent({
      llm,
      sessionBackend: "memory",
      policy: { autoApprove: true },
      tools: [
        defineLocalTool({
          name: "echo",
          description: "Echo",
          risk: "read",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
          execute: ({ text }) => ({ text }),
        }),
      ],
    });

    const server = await createMiniAgentServer({
      host: "127.0.0.1",
      port: 0,
      apiKey: "test-key",
      agent,
      enableBuiltinTools: false,
    });

    try {
      const client = new MiniAgentClient({
        baseUrl: `http://127.0.0.1:${server.port}`,
        apiKey: "test-key",
      });
      const session = await client.createSession();
      const cases: string[] = [];
      for await (const event of client.run({
        sessionId: session.id,
        message: "echo please",
      })) {
        if (event.payload.case) cases.push(event.payload.case);
      }
      assert.deepEqual(cases, [
        "runStarted",
        "toolCall",
        "toolResult",
        "textDelta",
        "runCompleted",
      ]);
    } finally {
      await server.close();
    }
  });

  it("requires ResolveToolApproval for write tools", async () => {
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
                name: "risky_write",
                arguments: JSON.stringify({ path: "x.txt", content: "hi" }),
              },
            ],
          },
        };
      }
      return {
        finishReason: "stop",
        message: { role: "assistant", content: "done" },
      };
    });

    const agent = await createAgent({
      llm,
      sessionBackend: "memory",
      policy: { autoApprove: false },
      tools: [
        defineLocalTool({
          name: "risky_write",
          description: "Write something",
          risk: "write",
          requiresApproval: true,
          sideEffect: true,
          execute: () => ({ ok: true }),
        }),
      ],
    });

    const server = await createMiniAgentServer({
      host: "127.0.0.1",
      port: 0,
      apiKey: "test-key",
      agent,
      enableBuiltinTools: false,
    });

    try {
      const client = new MiniAgentClient({
        baseUrl: `http://127.0.0.1:${server.port}`,
        apiKey: "test-key",
      });
      const session = await client.createSession();
      const cases: string[] = [];
      for await (const event of client.run({
        sessionId: session.id,
        message: "write please",
      })) {
        if (event.payload.case) cases.push(event.payload.case);
        if (event.payload.case === "toolApprovalRequired") {
          const res = await client.resolveToolApproval({
            runId: event.runId,
            approvalId: event.payload.value.approvalId,
            decision: "approve",
          });
          assert.equal(res.ok, true);
        }
      }
      assert.deepEqual(cases, [
        "runStarted",
        "toolApprovalRequired",
        "toolCall",
        "toolResult",
        "textDelta",
        "runCompleted",
      ]);
    } finally {
      await server.close();
    }
  });
});
