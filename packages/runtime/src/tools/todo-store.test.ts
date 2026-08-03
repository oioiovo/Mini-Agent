import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  applyTodoWrite,
  loadTodos,
  saveTodos,
  sanitizeSessionId,
  todoFilePath,
} from "./todo-store.js";

describe("todo-store", () => {
  it("merges by id and replaces when merge=false", () => {
    const base = [
      { id: "a", content: "A", status: "pending" as const },
      { id: "b", content: "B", status: "pending" as const },
    ];
    const merged = applyTodoWrite(base, {
      merge: true,
      todos: [{ id: "a", content: "A2", status: "completed" }],
    });
    assert.equal(merged.todos.length, 2);
    assert.deepEqual(
      merged.todos.find((t) => t.id === "a"),
      { id: "a", content: "A2", status: "completed" },
    );

    const replaced = applyTodoWrite(base, {
      merge: false,
      todos: [{ id: "c", content: "C", status: "in_progress" }],
    });
    assert.deepEqual(replaced.todos, [
      { id: "c", content: "C", status: "in_progress" },
    ]);
  });

  it("warns when multiple in_progress", () => {
    const result = applyTodoWrite([], {
      merge: false,
      todos: [
        { id: "a", content: "A", status: "in_progress" },
        { id: "b", content: "B", status: "in_progress" },
      ],
    });
    assert.match(result.warning ?? "", /Multiple in_progress/);
  });

  it("rejects invalid payloads", () => {
    assert.throws(() => applyTodoWrite([], { todos: [] }), /non-empty/);
    assert.throws(
      () =>
        applyTodoWrite([], {
          todos: [
            { id: "a", content: "A", status: "pending" },
            { id: "a", content: "A2", status: "pending" },
          ],
        }),
      /Duplicate/,
    );
    assert.throws(
      () =>
        applyTodoWrite([], {
          todos: [{ id: "a", content: "A", status: "nope" as "pending" }],
        }),
      /status/,
    );
  });

  it("persists under workspace .mini-agent/todos/<sessionId>.json", () => {
    const root = mkdtempSync(join(tmpdir(), "mini-agent-todo-"));
    const sessionId = "sess_abc";
    const todos = [{ id: "t1", content: "one", status: "pending" as const }];
    saveTodos(root, sessionId, todos);
    const path = todoFilePath(root, sessionId);
    assert.match(path.replace(/\\/g, "/"), /\.mini-agent\/todos\/sess_abc\.json$/);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), todos);
    assert.deepEqual(loadTodos(root, sessionId), todos);
  });

  it("sanitizes session ids", () => {
    assert.equal(sanitizeSessionId("abc-123"), "abc-123");
    assert.throws(() => sanitizeSessionId("../x"), /Invalid sessionId/);
  });
});
