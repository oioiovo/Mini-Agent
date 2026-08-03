import { defineLocalTool } from "@mini-agent/runtime";
import type { CaseContext } from "../src/types.js";

export async function before(ctx: CaseContext): Promise<void> {
  ctx.extraTools.push(
    defineLocalTool({
      name: "risky_write",
      description: "Write something",
      risk: "write",
      requiresApproval: true,
      sideEffect: true,
      execute: () => ({ ok: true }),
    }),
  );
}
