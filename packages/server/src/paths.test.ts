import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { findRepoRoot, resolveFromRepo } from "./paths.js";

describe("paths", () => {
  it("finds monorepo root from a nested package cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "mini-agent-root-"));
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    const nested = join(root, "packages", "server");
    mkdirSync(nested, { recursive: true });

    assert.equal(findRepoRoot([nested]), resolve(root));
  });

  it("resolves relative workspace against repo root, not cwd", () => {
    const repoRoot = resolve("/repo");
    const cwdStyle = resolve("/repo/packages/server");
    // Simulate the old bug: resolve(cwd, "./workspace") would land under packages/server.
    const wrong = resolve(cwdStyle, "./workspace");
    const right = resolveFromRepo(repoRoot, "./workspace", "workspace");
    assert.notEqual(wrong, right);
    assert.equal(right, resolve(repoRoot, "workspace"));
  });

  it("keeps absolute workspace paths unchanged", () => {
    const abs = resolve("/tmp/custom-ws");
    assert.equal(resolveFromRepo("/repo", abs, "workspace"), abs);
  });
});
