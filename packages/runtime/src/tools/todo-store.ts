import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureWorkspaceRoot, resolveSafePath } from "./workspace.js";

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

export interface TodoWriteInput {
  merge?: boolean;
  todos: TodoItem[];
}

export interface TodoWriteResult {
  todos: TodoItem[];
  warning?: string;
}

const STATUSES = new Set<TodoStatus>([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

/** Keep session ids path-safe under the workspace jail. */
export function sanitizeSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!trimmed) throw new Error("sessionId is required");
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new Error(`Invalid sessionId for todo storage: ${sessionId}`);
  }
  return trimmed;
}

export function todoFilePath(workspaceRoot: string, sessionId: string): string {
  const safeId = sanitizeSessionId(sessionId);
  const root = ensureWorkspaceRoot(workspaceRoot);
  return resolveSafePath(root, join(".mini-agent", "todos", `${safeId}.json`));
}

export function loadTodos(workspaceRoot: string, sessionId: string): TodoItem[] {
  const path = todoFilePath(workspaceRoot, sessionId);
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => normalizeTodoItem(item, index));
}

export function saveTodos(
  workspaceRoot: string,
  sessionId: string,
  todos: TodoItem[],
): void {
  const path = todoFilePath(workspaceRoot, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(todos, null, 2)}\n`, "utf8");
}

export function applyTodoWrite(
  existing: TodoItem[],
  input: TodoWriteInput,
): TodoWriteResult {
  const incoming = validateTodos(input.todos);
  const merge = input.merge !== false;

  let todos: TodoItem[];
  if (!merge) {
    todos = incoming;
  } else {
    const byId = new Map(existing.map((t) => [t.id, t]));
    for (const item of incoming) {
      byId.set(item.id, item);
    }
    todos = [...byId.values()];
  }

  const inProgress = todos.filter((t) => t.status === "in_progress");
  const result: TodoWriteResult = { todos };
  if (inProgress.length > 1) {
    result.warning = `Multiple in_progress todos (${inProgress.map((t) => t.id).join(", ")}); prefer keeping only one.`;
  }
  return result;
}

function validateTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("todos must be a non-empty array");
  }
  const seen = new Set<string>();
  return raw.map((item, index) => {
    const todo = normalizeTodoItem(item, index);
    if (seen.has(todo.id)) {
      throw new Error(`Duplicate todo id in request: ${todo.id}`);
    }
    seen.add(todo.id);
    return todo;
  });
}

function normalizeTodoItem(item: unknown, index: number): TodoItem {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error(`todos[${index}] must be an object`);
  }
  const obj = item as Record<string, unknown>;
  const id = String(obj.id ?? "").trim();
  const content = String(obj.content ?? "").trim();
  const status = String(obj.status ?? "").trim() as TodoStatus;
  if (!id) throw new Error(`todos[${index}].id is required`);
  if (!content) throw new Error(`todos[${index}].content is required`);
  if (!STATUSES.has(status)) {
    throw new Error(
      `todos[${index}].status must be one of ${[...STATUSES].join(", ")}`,
    );
  }
  return { id, content, status };
}
