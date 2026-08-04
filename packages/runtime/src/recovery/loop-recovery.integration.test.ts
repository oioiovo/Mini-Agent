import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createAgent } from "../create-agent.js";
import { FakeLlmClient } from "../providers/openai-compatible.js";
import { LlmHttpError } from "./errors.js";
import type { AgentEvent, LlmChatRequest } from "../types.js";

describe("error recovery integration", () => {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escalates max_tokens on length then completes", async () => {
    const root = mkdtempSync(join(tmpdir(), "mini-rec-esc-"));
    dirs.push(root);
    let calls = 0;
    const seenMax: number[] = [];
    const llm = new FakeLlmClient(async (request: LlmChatRequest) => {
      const system = request.messages.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("Extract durable") || system.includes("Select relevant")) {
        return { finishReason: "stop", message: { role: "assistant", content: "[]" } };
      }
      calls += 1;
      seenMax.push(request.maxTokens ?? -1);
      if (calls === 1) {
        return {
          finishReason: "length",
          message: { role: "assistant", content: "partial..." },
        };
      }
      return {
        finishReason: "stop",
        message: { role: "assistant", content: "done after escalate" },
      };
    });

    const agent = await createAgent({
      llm,
      workspaceRoot: root,
      sessionBackend: "memory",
      memory: { autoExtract: false, enabled: false },
      recovery: { defaultMaxTokens: 100, escalatedMaxTokens: 1000 },
    });

    try {
      const session = await agent.createSession();
      const events: AgentEvent[] = [];
      for await (const event of agent.run({
        sessionId: session.id,
        message: "write a lot",
      })) {
        events.push(event);
      }
      assert.ok(events.some((e) => e.type === "run.recovery" && e.kind === "max_tokens_escalate"));
      const done = events.find((e) => e.type === "run.completed");
      assert.ok(done && done.type === "run.completed");
      assert.match(done.finalText, /done after escalate/);
      assert.equal(seenMax[0], 100);
      assert.equal(seenMax[1], 1000);
    } finally {
      await agent.close();
    }
  });

  it("retries transient 429 then succeeds", async () => {
    const root = mkdtempSync(join(tmpdir(), "mini-rec-429-"));
    dirs.push(root);
    let calls = 0;
    const llm = new FakeLlmClient(async (request: LlmChatRequest) => {
      const system = request.messages.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("Extract durable") || system.includes("Select relevant")) {
        return { finishReason: "stop", message: { role: "assistant", content: "[]" } };
      }
      calls += 1;
      if (calls === 1) {
        throw new LlmHttpError({ status: 429, body: "rate", retryAfterMs: 1 });
      }
      return {
        finishReason: "stop",
        message: { role: "assistant", content: "after-retry" },
      };
    });

    const agent = await createAgent({
      llm,
      workspaceRoot: root,
      sessionBackend: "memory",
      memory: { enabled: false },
    });

    try {
      const session = await agent.createSession();
      const events: AgentEvent[] = [];
      for await (const event of agent.run({
        sessionId: session.id,
        message: "hi",
      })) {
        events.push(event);
      }
      assert.ok(events.some((e) => e.type === "run.recovery" && e.kind === "transient_retry"));
      const done = events.find((e) => e.type === "run.completed");
      assert.ok(done && done.type === "run.completed");
      assert.equal(done.finalText, "after-retry");
    } finally {
      await agent.close();
    }
  });

  it("errors with context_overflow after reactive compact still fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "mini-rec-ptl-"));
    dirs.push(root);
    let mainFails = 0;
    const llm = new FakeLlmClient(async (request: LlmChatRequest) => {
      const system = request.messages.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("Extract durable") || system.includes("Select relevant")) {
        return { finishReason: "stop", message: { role: "assistant", content: "[]" } };
      }
      if (system.includes("compressing a conversation")) {
        return {
          finishReason: "stop",
          message: { role: "assistant", content: "Summary: user said hi." },
        };
      }
      mainFails += 1;
      throw new Error("prompt_too_long: context window exceeded");
    });

    const agent = await createAgent({
      llm,
      workspaceRoot: root,
      sessionBackend: "memory",
      memory: { enabled: false },
      compact: { enabled: false },
    });

    try {
      const session = await agent.createSession();
      const events: AgentEvent[] = [];
      for await (const event of agent.run({
        sessionId: session.id,
        message: "hi",
      })) {
        events.push(event);
      }
      assert.ok(events.some((e) => e.type === "run.recovery" && e.kind === "reactive_compact"));
      const err = events.find((e) => e.type === "run.error");
      assert.ok(err && err.type === "run.error");
      assert.equal(err.code, "context_overflow");
      assert.ok(mainFails >= 2);
    } finally {
      await agent.close();
    }
  });
});
