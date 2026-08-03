import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createBuiltinTools } from "./builtins.js";
import { ToolRegistry } from "./registry.js";

describe("todo builtins", () => {
  it("todo_write then todo_read via registry", async () => {
    const root = mkdtempSync(join(tmpdir(), "mini-agent-todo-tool-"));
    const registry = new ToolRegistry();
    for (const tool of createBuiltinTools({ workspaceRoot: root })) {
      registry.register(tool);
    }
    const ctx = {
      sessionId: "sess_test_1",
      runId: "run1",
      abortSignal: new AbortController().signal,
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
      emitDelta() {},
    };
    const written = await registry.execute(
      "todo_write",
      JSON.stringify({
        merge: false,
        todos: [
          { id: "a", content: "A", status: "completed" },
          { id: "b", content: "B", status: "in_progress" },
        ],
      }),
      ctx,
    );
    assert.equal(written.isError, false, written.resultJson);
    const read = await registry.execute("todo_read", "{}", ctx);
    assert.equal(read.isError, false, read.resultJson);
    const body = JSON.parse(read.resultJson) as { todos: unknown[] };
    assert.equal(body.todos.length, 2);
  });
});
