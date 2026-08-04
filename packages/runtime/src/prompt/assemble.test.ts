import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assembleSystemPrompt,
  buildPromptContext,
  SystemPromptCache,
} from "./assemble.js";
import { DEFAULT_IDENTITY } from "./sections.js";

describe("assembleSystemPrompt", () => {
  it("always loads identity, tools, and workspace", () => {
    const ctx = buildPromptContext({
      toolNames: ["read_file", "now"],
      workspaceRoot: "/ws",
    });
    const result = assembleSystemPrompt(ctx);
    assert.deepEqual(result.sectionsLoaded, ["identity", "tools", "workspace"]);
    assert.match(result.prompt, /Working directory: \/ws/);
    assert.match(result.prompt, /now, read_file/);
    assert.match(result.prompt, /helpful agent/i);
    assert.ok(!result.sectionsLoaded.includes("memory"));
    assert.ok(!result.prompt.includes("# Durable memories"));
  });

  it("loads memory section only when index is non-empty", () => {
    const ctx = buildPromptContext({
      toolNames: ["memory_read"],
      workspaceRoot: "/ws",
      memoryIndex: "# Memory Index\n\n- [tabs](tabs.md) — prefers tabs\n",
    });
    const result = assembleSystemPrompt(ctx);
    assert.ok(result.sectionsLoaded.includes("memory"));
    assert.match(result.prompt, /Durable memories/);
    assert.match(result.prompt, /tabs\.md/);
  });

  it("uses identity override", () => {
    const ctx = buildPromptContext({
      identity: "You are a SQL expert.",
      toolNames: [],
      workspaceRoot: "/db",
    });
    const result = assembleSystemPrompt(ctx);
    assert.match(result.prompt, /SQL expert/);
    assert.ok(!result.prompt.includes(DEFAULT_IDENTITY.slice(0, 40)));
  });
});

describe("SystemPromptCache", () => {
  it("hits cache when context is unchanged", () => {
    const cache = new SystemPromptCache();
    const ctx = buildPromptContext({
      toolNames: ["a"],
      workspaceRoot: "/x",
    });
    const first = cache.get(ctx);
    const second = cache.get(ctx);
    assert.equal(first.prompt, second.prompt);
    assert.equal(cache.stats.misses, 1);
    assert.equal(cache.stats.hits, 1);
  });

  it("misses when tools or memory change", () => {
    const cache = new SystemPromptCache();
    cache.get(
      buildPromptContext({ toolNames: ["a"], workspaceRoot: "/x" }),
    );
    cache.get(
      buildPromptContext({ toolNames: ["a", "b"], workspaceRoot: "/x" }),
    );
    cache.get(
      buildPromptContext({
        toolNames: ["a", "b"],
        workspaceRoot: "/x",
        memoryIndex: "idx",
      }),
    );
    assert.equal(cache.stats.misses, 3);
    assert.equal(cache.stats.hits, 0);
  });
});
