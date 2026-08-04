import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  estimateTokens,
  microCompact,
  reactiveCompact,
  runCompactPipeline,
  snipCompact,
  toolResultBudget,
} from "../index.js";
import type { ChatMessage } from "../types.js";
import { FakeLlmClient } from "../providers/openai-compatible.js";
import { InMemorySessionStore } from "../session/memory-store.js";

function toolMsg(id: string, content: string): ChatMessage {
  return { role: "tool", toolCallId: id, name: "read_file", content };
}

function assistantTools(...ids: string[]): ChatMessage {
  return {
    role: "assistant",
    content: "",
    toolCalls: ids.map((id) => ({
      id,
      name: "read_file",
      arguments: "{}",
    })),
  };
}

describe("estimateTokens", () => {
  it("estimates from content length", () => {
    assert.equal(estimateTokens([{ role: "user", content: "abcd" }]), 1);
  });
});

describe("snipCompact", () => {
  it("keeps head and tail and does not split tool pairs", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "start" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "mid-a" },
      assistantTools("t1"),
      toolMsg("t1", "big-1"),
      { role: "user", content: "mid-b" },
      { role: "assistant", content: "tail" },
    ];
    // Force snip with tiny max
    const result = snipCompact(messages, { maxMessages: 5, keepHeadMessages: 2 });
    assert.equal(result.changed, true);
    assert.ok(result.messages.some((m) => m.content.includes("snipped")));
    // If tail includes a tool result, its assistant tool_use must precede it
    for (let i = 0; i < result.messages.length; i += 1) {
      const msg = result.messages[i]!;
      if (msg.role === "tool") {
        assert.ok(i > 0);
        const prev = result.messages[i - 1]!;
        assert.ok(
          prev.role === "tool" ||
            (prev.toolCalls?.some((c) => c.id === msg.toolCallId) ?? false) ||
            result.messages
              .slice(0, i)
              .some((m) => m.toolCalls?.some((c) => c.id === msg.toolCallId)),
        );
      }
    }
  });
});

describe("microCompact", () => {
  it("placeholders older tool results", () => {
    const messages: ChatMessage[] = [
      assistantTools("a", "b", "c", "d"),
      toolMsg("a", "x".repeat(200)),
      toolMsg("b", "y".repeat(200)),
      toolMsg("c", "z".repeat(200)),
      toolMsg("d", "w".repeat(200)),
    ];
    const result = microCompact(messages, { keepRecentToolResults: 2 });
    assert.equal(result.changed, true);
    assert.match(result.messages[1]!.content, /Earlier tool result compacted/);
    assert.match(result.messages[2]!.content, /Earlier tool result compacted/);
    assert.equal(result.messages[3]!.content.length, 200);
    assert.equal(result.messages[4]!.content.length, 200);
  });
});

describe("toolResultBudget", () => {
  it("persists large tool outputs to workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "mini-agent-budget-"));
    try {
      const huge = "H".repeat(50_000);
      const messages: ChatMessage[] = [
        assistantTools("big"),
        toolMsg("big", huge),
        toolMsg("small", "ok"),
      ];
      const result = toolResultBudget(messages, {
        sessionId: "sess1",
        workspaceRoot: root,
        maxToolResultBytes: 10_000,
        toolResultPreviewChars: 100,
      });
      assert.equal(result.changed, true);
      assert.match(result.messages[1]!.content, /persisted-output/);
      const persisted = readFileSync(
        join(root, ".mini-agent", "tool-results", "sess1", "big.txt"),
        "utf8",
      );
      assert.equal(persisted.length, 50_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runCompactPipeline + L4", () => {
  it("forceLlm replaces history with summary", async () => {
    const root = mkdtempSync(join(tmpdir(), "mini-agent-l4-"));
    try {
      const llm = new FakeLlmClient(async () => ({
        message: { role: "assistant", content: "Goal: ship compact\nFiles: a.ts" },
        finishReason: "stop",
      }));
      const messages: ChatMessage[] = [
        { role: "user", content: "please help" },
        { role: "assistant", content: "sure" },
      ];
      const result = await runCompactPipeline({
        messages,
        sessionId: "s1",
        workspaceRoot: root,
        llm,
        model: "fake",
        forceLlm: true,
        options: { autoCompactThreshold: 1 },
      });
      assert.ok(result.layers.includes("manual"));
      assert.equal(result.messages.length, 1);
      assert.match(result.messages[0]!.content, /Compacted/);
      assert.match(result.messages[0]!.content, /ship compact/);
      assert.ok(result.transcriptPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reactiveCompact keeps a short tail", async () => {
    const root = mkdtempSync(join(tmpdir(), "mini-agent-reactive-"));
    try {
      const llm = new FakeLlmClient(async () => ({
        message: { role: "assistant", content: "summary" },
        finishReason: "stop",
      }));
      const messages: ChatMessage[] = Array.from({ length: 10 }, (_, i) => ({
        role: "user" as const,
        content: `m${i}`,
      }));
      const result = await reactiveCompact(messages, {
        llm,
        model: "fake",
        workspaceRoot: root,
        sessionId: "s1",
      });
      assert.deepEqual(result.layers, ["reactive"]);
      assert.ok(result.messages.length >= 2);
      assert.match(result.messages[0]!.content, /Reactive compact/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("SessionStore.replaceMessages", () => {
  it("replaces history", async () => {
    const store = new InMemorySessionStore();
    const session = await store.create({});
    await store.appendMessages(session.id, [{ role: "user", content: "a" }]);
    const replaced = await store.replaceMessages(session.id, [
      { role: "user", content: "compacted" },
    ]);
    assert.equal(replaced.messages.length, 1);
    assert.equal(replaced.messages[0]?.content, "compacted");
  });
});
