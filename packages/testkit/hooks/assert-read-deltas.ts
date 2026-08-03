import type { CaseContext, CaseResult } from "../src/types.js";

export async function after(ctx: CaseContext, result: CaseResult): Promise<void> {
  const marker = ctx.vars.fixture_marker;
  if (!marker) throw new Error("fixture_marker missing");
  if (result.trace.deltas.length === 0) {
    result.status = "failed";
    result.error = { message: "expected at least one toolResultDelta chunk" };
    return;
  }
  if (!result.trace.deltas.join("").includes(marker)) {
    result.status = "failed";
    result.error = { message: "toolResultDelta chunks missing fixture marker" };
  }
}
