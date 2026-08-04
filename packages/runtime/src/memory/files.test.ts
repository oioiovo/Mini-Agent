import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  clipMemoryBody,
  formatMemoryIndexBlock,
  listMemoryFiles,
  readMemoryFile,
  readMemoryIndex,
  rebuildMemoryIndex,
  resolveMemoryRoot,
  writeMemoryFile,
} from "./files.js";

describe("memory files", () => {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "mini-mem-files-"));
    dirs.push(dir);
    return dir;
  }

  it("resolves default root under workspace .mini-agent/memory", () => {
    const root = resolveMemoryRoot({ workspaceRoot: "/ws" });
    assert.equal(root.replace(/\\/g, "/"), "/ws/.mini-agent/memory");
  });

  it("writes frontmatter files and rebuilds MEMORY.md index", () => {
    const root = tmp();
    const file = writeMemoryFile(root, {
      name: "user-preference-tabs",
      description: "User prefers tabs for indentation",
      type: "user",
      body: "User prefers using tabs, not spaces.",
    });
    assert.equal(file.filename, "user-preference-tabs.md");
    const raw = readFileSync(join(root, file.filename), "utf8");
    assert.match(raw, /^---\n/);
    assert.match(raw, /type: user/);
    assert.match(raw, /User prefers using tabs/);

    const index = readMemoryIndex(root);
    assert.match(index, /user-preference-tabs\.md/);
    assert.match(index, /User prefers tabs/);

    const listed = listMemoryFiles(root);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.name, "user-preference-tabs");

    const loaded = readMemoryFile(root, file.filename);
    assert.ok(loaded);
    assert.equal(loaded.type, "user");
    assert.equal(loaded.body, "User prefers using tabs, not spaces.");
  });

  it("formats index block for system injection", () => {
    const block = formatMemoryIndexBlock("# Memory Index\n\n- [a](a.md) — desc\n");
    assert.match(block, /Durable memories/);
    assert.match(block, /\[a\]\(a\.md\)/);
  });

  it("clips body by lines and bytes", () => {
    const long = Array.from({ length: 250 }, (_, i) => `line-${i}`).join("\n");
    const clipped = clipMemoryBody(long, 10, 4096);
    assert.ok(clipped.split("\n").length <= 12);
    assert.match(clipped, /truncated/);
  });

  it("rebuilds empty index when no files", () => {
    const root = tmp();
    const text = rebuildMemoryIndex(root);
    assert.match(text, /# Memory Index/);
    assert.equal(listMemoryFiles(root).length, 0);
  });
});
