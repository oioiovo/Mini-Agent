import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createAgent } from "../create-agent.js";
import { FakeLlmClient } from "../providers/openai-compatible.js";
import type { AgentEvent } from "../types.js";

describe("subagent", () => {
  it("streams subagent events and returns final text to parent", async () => {
    const root = mkdtempSync(join(tmpdir(), "mini-agent-sub-"));
    let step = 0;
    const llm = new FakeLlmClient(async () => {
      step += 1;
      // Parent: call run_subagent
      if (step === 1) {
        return {
          finishReason: "tool_calls",
          message: {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "c1",
                name: "run_subagent",
                arguments: JSON.stringify({
                  prompt: "Say hello from the subagent.",
                  description: "greet",
                }),
              },
            ],
          },
        };
      }
      // Child: final answer (no tools)
      if (step === 2) {
        return {
          finishReason: "stop",
          message: { role: "assistant", content: "hello-from-sub" },
        };
      }
      // Parent: wrap up
      return {
        finishReason: "stop",
        message: { role: "assistant", content: "Parent done: hello-from-sub" },
      };
    });

    const agent = await createAgent({
      llm,
      workspaceRoot: root,
      includeBuiltinTools: true,
      sessionBackend: "memory",
      policy: { autoApprove: true },
      tools: [],
    });

    try {
      assert.ok(agent.listTools().some((t) => t.name === "run_subagent"));
      const session = await agent.createSession();
      const events: AgentEvent[] = [];
      for await (const event of agent.run({
        sessionId: session.id,
        message: "delegate greeting",
      })) {
        events.push(event);
      }

      assert.ok(events.some((e) => e.type === "subagent.started"));
      assert.ok(events.some((e) => e.type === "subagent.progress" && e.kind === "text_delta"));
      const completed = events.find((e) => e.type === "subagent.completed");
      assert.ok(completed && completed.type === "subagent.completed");
      assert.equal(completed.isError, false);
      assert.match(completed.finalText, /hello-from-sub/);

      const toolDone = events.find(
        (e) => e.type === "tool.completed" && e.toolName === "run_subagent",
      );
      assert.ok(toolDone && toolDone.type === "tool.completed");
      assert.equal(toolDone.isError, false);
      assert.match(toolDone.resultJson, /hello-from-sub/);

      const parentDone = events.find((e) => e.type === "run.completed");
      assert.ok(parentDone && parentDone.type === "run.completed");
      assert.match(parentDone.finalText, /Parent done/);
    } finally {
      await agent.close();
    }
  });

  it("does not expose run_subagent inside the child tool set", async () => {
    const root = mkdtempSync(join(tmpdir(), "mini-agent-sub-depth-"));
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
                name: "run_subagent",
                arguments: JSON.stringify({
                  prompt: "Try to nest by calling run_subagent if available; else say ok.",
                }),
              },
            ],
          },
        };
      }
      // Child asks for run_subagent
      if (step === 2) {
        return {
          finishReason: "tool_calls",
          message: {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "c2",
                name: "run_subagent",
                arguments: JSON.stringify({ prompt: "nested" }),
              },
            ],
          },
        };
      }
      // Child continues after unknown tool error
      if (step === 3) {
        return {
          finishReason: "stop",
          message: { role: "assistant", content: "no-nested" },
        };
      }
      return {
        finishReason: "stop",
        message: { role: "assistant", content: "parent-ok" },
      };
    });

    const agent = await createAgent({
      llm,
      workspaceRoot: root,
      includeBuiltinTools: true,
      sessionBackend: "memory",
      tools: [],
    });

    try {
      const session = await agent.createSession();
      const events: AgentEvent[] = [];
      for await (const event of agent.run({
        sessionId: session.id,
        message: "nest?",
      })) {
        events.push(event);
      }

      const childTool = events.find(
        (e) =>
          e.type === "subagent.progress" &&
          e.kind === "tool_result" &&
          e.toolName === "run_subagent",
      );
      assert.ok(childTool && childTool.type === "subagent.progress");
      assert.match(childTool.payloadJson ?? "", /Unknown tool|not allowed|error/i);

      const completed = events.find((e) => e.type === "subagent.completed");
      assert.ok(completed && completed.type === "subagent.completed");
      assert.match(completed.finalText, /no-nested/);
    } finally {
      await agent.close();
    }
  });
});
