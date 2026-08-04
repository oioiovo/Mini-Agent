import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createAgent } from "../create-agent.js";
import { FakeLlmClient } from "../providers/openai-compatible.js";
import type { AgentEvent, LlmChatRequest } from "../types.js";
import { writeMemoryFile } from "./files.js";

describe("file memory integration", () => {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers memory tools and injects index on subsequent run", async () => {
    const root = mkdtempSync(join(tmpdir(), "mini-mem-int-"));
    dirs.push(root);
    const memRoot = join(root, ".mini-agent", "memory");

    let calls = 0;
    const llm = new FakeLlmClient(async (request: LlmChatRequest) => {
      calls += 1;
      const system = request.messages.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("Extract durable") || system.includes("Select relevant")) {
        if (system.includes("Extract durable")) {
          return {
            finishReason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify([
                {
                  name: "likes-dark-mode",
                  type: "user",
                  description: "Prefers dark mode",
                  body: "User prefers dark mode UI.",
                },
              ]),
            },
          };
        }
        return {
          finishReason: "stop",
          message: { role: "assistant", content: "[0]" },
        };
      }
      const user = [...request.messages].reverse().find((m) => m.role === "user");
      if (calls <= 2 && system.includes("Durable memories")) {
        assert.match(system, /likes-dark-mode|Memory Index/);
      }
      if (user?.content.includes("[Relevant memories]")) {
        assert.match(user.content, /dark mode/i);
      }
      return {
        finishReason: "stop",
        message: { role: "assistant", content: "ack" },
      };
    });

    const agent = await createAgent({
      llm,
      workspaceRoot: root,
      includeBuiltinTools: true,
      sessionBackend: "memory",
      memory: { autoExtract: true },
    });

    try {
      assert.ok(agent.listTools().some((t) => t.name === "memory_write"));
      assert.ok(agent.listTools().some((t) => t.name === "memory_read"));
      assert.ok(agent.durableMemory);

      const session = await agent.createSession();
      for await (const _ of agent.run({
        sessionId: session.id,
        message: "I prefer dark mode.",
      })) {
        // drain
      }

      assert.ok(existsSync(memRoot));
      const files = readdirSync(memRoot).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
      assert.ok(files.some((f) => f.includes("likes-dark-mode")));

      const events: AgentEvent[] = [];
      for await (const event of agent.run({
        sessionId: session.id,
        message: "What UI theme do I like?",
      })) {
        events.push(event);
      }
      assert.ok(events.some((e) => e.type === "memory.hit"));
      const done = events.find((e) => e.type === "run.completed");
      assert.ok(done && done.type === "run.completed");
      assert.equal(done.finalText, "ack");
    } finally {
      await agent.close();
    }
  });

  it("memory_write tool persists a file", async () => {
    const root = mkdtempSync(join(tmpdir(), "mini-mem-tool-"));
    dirs.push(root);
    writeMemoryFile(join(root, ".mini-agent", "memory"), {
      name: "seed",
      description: "seed",
      type: "project",
      body: "seed body",
    });

    let step = 0;
    const llm = new FakeLlmClient(async (request) => {
      const system = request.messages.find((m) => m.role === "system")?.content ?? "";
      if (
        system.includes("Extract durable") ||
        system.includes("Select relevant") ||
        system.includes("Consolidate durable")
      ) {
        return {
          finishReason: "stop",
          message: { role: "assistant", content: "[]" },
        };
      }
      step += 1;
      if (step === 1) {
        return {
          finishReason: "tool_calls",
          message: {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "mw1",
                name: "memory_write",
                arguments: JSON.stringify({
                  name: "api-base",
                  description: "API base URL",
                  type: "project",
                  body: "Base URL is https://api.example.com",
                }),
              },
            ],
          },
        };
      }
      return {
        finishReason: "stop",
        message: { role: "assistant", content: "saved" },
      };
    });

    const agent = await createAgent({
      llm,
      workspaceRoot: root,
      includeBuiltinTools: true,
      sessionBackend: "memory",
      policy: { autoApprove: true },
    });

    try {
      const session = await agent.createSession();
      for await (const _ of agent.run({
        sessionId: session.id,
        message: "remember the api base",
      })) {
        // drain
      }
      const file = agent.durableMemory?.read("api-base.md");
      assert.ok(file);
      assert.match(file.body, /api\.example\.com/);
    } finally {
      await agent.close();
    }
  });
});
