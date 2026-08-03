import { defineLocalTool } from "@mini-agent/runtime";
import type { CaseContext } from "../src/types.js";

export async function before(ctx: CaseContext): Promise<void> {
  ctx.extraTools.push(
    defineLocalTool({
      name: "streamy",
      description: "stream",
      risk: "read",
      execute: (_args, toolCtx) => {
        toolCtx.emitDelta("chunk-1");
        toolCtx.emitDelta("chunk-2");
        return { ok: true };
      },
    }),
  );
}
