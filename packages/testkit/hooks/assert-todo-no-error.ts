import type { CaseContext, CaseResult } from "../src/types.js";

export async function after(_ctx: CaseContext, result: CaseResult): Promise<void> {
  const errored = result.trace.toolResults.filter((t) => t.isError);
  if (errored.length) {
    result.status = "failed";
    result.error = {
      message: `tool errors: ${errored.map((t) => `${t.toolName}:${t.resultJson}`).join("; ")}`,
    };
  }
  const read = result.trace.toolResults.find((t) => t.toolName === "todo_read" && !t.isError);
  if (!read) {
    result.status = "failed";
    result.error = { message: "todo_read did not succeed" };
    return;
  }
  const body = JSON.parse(read.resultJson) as { todos?: unknown[] };
  if (!Array.isArray(body.todos) || body.todos.length !== 2) {
    result.status = "failed";
    result.error = { message: `expected 2 todos, got ${read.resultJson}` };
  }
}
