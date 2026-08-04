import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { FakeLlmClient } from "../providers/openai-compatible.js";
import { listMemoryFiles, writeMemoryFile } from "./files.js";
import { extractMemories } from "./extract.js";
import { consolidateMemories } from "./consolidate.js";

describe("memory extract / consolidate", () => {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes new memories from FakeLlm JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "mini-mem-extract-"));
    dirs.push(root);
    const llm = new FakeLlmClient(async () => ({
      finishReason: "stop",
      message: {
        role: "assistant",
        content: JSON.stringify([
          {
            name: "prefers-tabs",
            type: "user",
            description: "Tabs for indent",
            body: "User prefers tabs.",
          },
        ]),
      },
    }));

    const result = await extractMemories({
      root,
      messages: [
        { role: "user", content: "I prefer tabs for indentation." },
        { role: "assistant", content: "Got it, I will use tabs." },
      ],
      llm,
      model: "fake",
      consolidateThreshold: 100,
    });

    assert.equal(result.written, 1);
    assert.equal(result.consolidated, false);
    const files = listMemoryFiles(root);
    assert.equal(files.length, 1);
    assert.equal(files[0]!.name, "prefers-tabs");
  });

  it("skips names already in catalog", async () => {
    const root = mkdtempSync(join(tmpdir(), "mini-mem-extract-dup-"));
    dirs.push(root);
    writeMemoryFile(root, {
      name: "prefers-tabs",
      description: "existing",
      type: "user",
      body: "old",
    });
    const llm = new FakeLlmClient(async () => ({
      finishReason: "stop",
      message: {
        role: "assistant",
        content: JSON.stringify([
          {
            name: "prefers-tabs",
            type: "user",
            description: "dup",
            body: "new",
          },
        ]),
      },
    }));
    const result = await extractMemories({
      root,
      messages: [{ role: "user", content: "tabs again" }],
      llm,
      model: "fake",
      consolidateThreshold: 100,
    });
    assert.equal(result.written, 0);
    assert.equal(listMemoryFiles(root).length, 1);
  });

  it("consolidates when threshold reached", async () => {
    const root = mkdtempSync(join(tmpdir(), "mini-mem-consol-"));
    dirs.push(root);
    writeMemoryFile(root, {
      name: "a",
      description: "a",
      type: "project",
      body: "alpha",
    });
    writeMemoryFile(root, {
      name: "b",
      description: "b",
      type: "project",
      body: "beta",
    });
    const llm = new FakeLlmClient(async () => ({
      finishReason: "stop",
      message: {
        role: "assistant",
        content: JSON.stringify([
          {
            name: "merged",
            type: "project",
            description: "merged a+b",
            body: "alpha and beta",
          },
        ]),
      },
    }));
    const result = await consolidateMemories({ root, llm, model: "fake" });
    assert.equal(result.replaced, 1);
    const files = listMemoryFiles(root);
    assert.equal(files.length, 1);
    assert.equal(files[0]!.name, "merged");
  });
});
