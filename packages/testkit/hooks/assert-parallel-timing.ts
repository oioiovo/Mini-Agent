import type { CaseContext, CaseResult } from "../src/types.js";

export async function after(ctx: CaseContext, result: CaseResult): Promise<void> {
  const started = Number(ctx.vars.parallel_started_at ?? "0");
  const elapsed = Date.now() - started;
  // Serial would be ~160ms+; parallel should be closer to ~80ms.
  if (elapsed >= 150) {
    result.status = "failed";
    result.error = {
      message: `expected parallel (~80ms), got ${elapsed}ms`,
    };
  }
  ctx.log("parallel.timing", { elapsed });
}
