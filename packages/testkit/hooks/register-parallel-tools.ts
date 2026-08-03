import { defineLocalTool } from "@mini-agent/runtime";
import type { CaseContext } from "../src/types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function before(ctx: CaseContext): Promise<void> {
  ctx.vars.parallel_started_at = String(Date.now());
  ctx.extraTools.push(
    defineLocalTool({
      name: "slow_a",
      description: "slow a",
      risk: "read",
      execute: async () => {
        await sleep(80);
        return { name: "a" };
      },
    }),
    defineLocalTool({
      name: "slow_b",
      description: "slow b",
      risk: "read",
      execute: async () => {
        await sleep(80);
        return { name: "b" };
      },
    }),
  );
}
