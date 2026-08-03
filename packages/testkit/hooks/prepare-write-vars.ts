import type { CaseContext } from "../src/types.js";

export async function before(ctx: CaseContext): Promise<void> {
  ctx.vars.file_name = `live-write-${Date.now()}.txt`;
  ctx.vars.write_token = `WRITE_OK_${Date.now()}`;
  ctx.log("write.vars", ctx.vars);
}
