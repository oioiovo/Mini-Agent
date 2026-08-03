import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CaseContext, CaseResult } from "../src/types.js";

export async function after(ctx: CaseContext, result: CaseResult): Promise<void> {
  const fileName = ctx.vars.file_name;
  const token = ctx.vars.write_token;
  if (!fileName || !token) throw new Error("write vars missing");
  const path = resolve(ctx.workspaceRoot, fileName);
  if (!existsSync(path)) {
    result.status = "failed";
    result.error = { message: `expected written file at ${path}` };
    return;
  }
  const body = readFileSync(path, "utf8");
  if (!body.includes(token)) {
    result.status = "failed";
    result.error = { message: `file missing token ${token}` };
  }
}
