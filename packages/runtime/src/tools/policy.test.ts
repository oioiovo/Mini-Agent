import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalBroker } from "./approval.js";
import { ToolPolicy } from "./policy.js";
import { resolveSafePath, WorkspacePathError } from "./workspace.js";

describe("ToolPolicy", () => {
  it("allows read tools", () => {
    const policy = new ToolPolicy({ autoApprove: false });
    const result = policy.evaluate({
      name: "read_file",
      risk: "read",
      requiresApproval: false,
    });
    assert.equal(result.decision, "allow");
  });

  it("requires approval for write tools", () => {
    const policy = new ToolPolicy({ autoApprove: false });
    const result = policy.evaluate({
      name: "write_file",
      risk: "write",
      requiresApproval: true,
    });
    assert.equal(result.decision, "require_approval");
  });

  it("auto-approves when enabled", () => {
    const policy = new ToolPolicy({ autoApprove: true });
    const result = policy.evaluate({
      name: "http_request",
      risk: "network",
      requiresApproval: true,
    });
    assert.equal(result.decision, "allow");
  });
});

describe("ApprovalBroker", () => {
  it("resolves approve", async () => {
    const broker = new ApprovalBroker();
    const wait = broker.begin("run1", "a1", 1000);
    const result = broker.resolve("run1", "a1", "approve");
    assert.equal(result.ok, true);
    assert.equal(await wait, "approve");
  });

  it("times out", async () => {
    const broker = new ApprovalBroker();
    const decision = await broker.begin("run1", "a2", 20);
    assert.equal(decision, "timeout");
  });
});

describe("workspace path", () => {
  it("rejects path escape", () => {
    const root = mkdtempSync(join(tmpdir(), "mini-agent-ws-"));
    writeFileSync(join(root, "ok.txt"), "x");
    assert.throws(() => resolveSafePath(root, "../outside.txt"), WorkspacePathError);
    assert.equal(resolveSafePath(root, "ok.txt"), join(root, "ok.txt"));
  });
});
