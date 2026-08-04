import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createAgent } from "../create-agent.js";
import { FakeLlmClient } from "../providers/openai-compatible.js";
import type { LlmChatRequest } from "../types.js";
import { writeMemoryFile } from "../memory/files.js";

describe("system prompt assembly in loop", () => {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("injects workspace and tool names into system", async () => {
    const root = mkdtempSync(join(tmpdir(), "mini-prompt-"));
    dirs.push(root);
    let seenSystem = "";
    const llm = new FakeLlmClient(async (request: LlmChatRequest) => {
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
      seenSystem = system;
      return {
        finishReason: "stop",
        message: { role: "assistant", content: "ok" },
      };
    });

    const agent = await createAgent({
      llm,
      workspaceRoot: root,
      includeBuiltinTools: true,
      sessionBackend: "memory",
      memory: { autoExtract: false },
    });

    try {
      const session = await agent.createSession();
      for await (const _ of agent.run({
        sessionId: session.id,
        message: "hi",
      })) {
        // drain
      }
      assert.ok(seenSystem.includes(`Working directory: ${root}`));
      assert.match(seenSystem, /read_file/);
      assert.match(seenSystem, /Available tools/);
    } finally {
      await agent.close();
    }
  });

  it("includes memory index section after memories exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "mini-prompt-mem-"));
    dirs.push(root);
    writeMemoryFile(join(root, ".mini-agent", "memory"), {
      name: "prefers-tabs",
      description: "tabs",
      type: "user",
      body: "Use tabs",
    });

    let seenSystem = "";
    const llm = new FakeLlmClient(async (request: LlmChatRequest) => {
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
      seenSystem = system;
      return {
        finishReason: "stop",
        message: { role: "assistant", content: "ok" },
      };
    });

    const agent = await createAgent({
      llm,
      workspaceRoot: root,
      includeBuiltinTools: true,
      sessionBackend: "memory",
      memory: { autoExtract: false },
    });

    try {
      const session = await agent.createSession();
      for await (const _ of agent.run({
        sessionId: session.id,
        message: "remember my prefs?",
      })) {
        // drain
      }
      assert.match(seenSystem, /Durable memories/);
      assert.match(seenSystem, /prefers-tabs/);
    } finally {
      await agent.close();
    }
  });
});
