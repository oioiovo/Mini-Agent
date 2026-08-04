import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { FakeLlmClient } from "../providers/openai-compatible.js";
import { writeMemoryFile } from "./files.js";
import {
  formatRelevantMemoriesBlock,
  loadMemoryBodies,
  selectMemoriesByKeyword,
  selectRelevantMemories,
} from "./select.js";

describe("memory select", () => {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function seed() {
    const root = mkdtempSync(join(tmpdir(), "mini-mem-select-"));
    dirs.push(root);
    writeMemoryFile(root, {
      name: "tabs-preference",
      description: "User prefers tabs for indentation",
      type: "user",
      body: "Always use tabs.",
    });
    writeMemoryFile(root, {
      name: "deploy-host",
      description: "Production host is api.example.com",
      type: "project",
      body: "Deploy to api.example.com",
    });
    return root;
  }

  it("falls back to keyword match on name and description", () => {
    const root = seed();
    const files = selectMemoriesByKeyword(
      [
        {
          filename: "a.md",
          name: "tabs-preference",
          description: "User prefers tabs for indentation",
          type: "user",
          body: "x",
          mtimeMs: 1,
        },
        {
          filename: "b.md",
          name: "deploy-host",
          description: "Production host",
          type: "project",
          body: "y",
          mtimeMs: 2,
        },
      ],
      "tabs indentation",
      5,
    );
    assert.equal(files.length, 1);
    assert.equal(files[0]!.name, "tabs-preference");
    void root;
  });

  it("uses LLM indices when available", async () => {
    const root = seed();
    const llm = new FakeLlmClient(async () => ({
      finishReason: "stop",
      message: { role: "assistant", content: "[0]" },
    }));
    const selected = await selectRelevantMemories({
      root,
      query: "where do we deploy?",
      llm,
      model: "fake",
      maxItems: 5,
    });
    assert.equal(selected.length, 1);
    assert.equal(selected[0]!.name, "deploy-host");
  });

  it("loads bodies under budget and formats user prefix", () => {
    const root = seed();
    const files = selectMemoriesByKeyword(
      [
        {
          filename: "tabs-preference.md",
          name: "tabs-preference",
          description: "tabs",
          type: "user",
          body: "Always use tabs.",
          mtimeMs: 1,
        },
      ],
      "tabs",
    );
    const loaded = loadMemoryBodies(root, files);
    assert.equal(loaded.length, 1);
    const block = formatRelevantMemoriesBlock(loaded);
    assert.match(block, /\[Relevant memories\]/);
    assert.match(block, /Always use tabs/);
  });
});
