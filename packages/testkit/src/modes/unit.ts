import {
  createAgent,
  type MiniAgent,
  type RegisteredTool,
} from "@mini-agent/runtime";
import { createFakeLlmFromSteps } from "../fake-llm.js";
import { createTrace, ingestRuntimeEvent } from "../collect.js";
import { withInterpolatedFakeLlm } from "../interpolate-case.js";
import type { CaseContext, RunTrace } from "../types.js";

export async function runUnitCase(ctx: CaseContext): Promise<RunTrace> {
  const caseDef = withInterpolatedFakeLlm(ctx.caseDef, ctx.vars);
  const llm = createFakeLlmFromSteps(caseDef.fake_llm);
  const agent = await createAgent({
    llm,
    sessionBackend: "memory",
    workspaceRoot: ctx.workspaceRoot,
    includeBuiltinTools: caseDef.builtins !== false,
    tools: ctx.extraTools,
    policy: { autoApprove: caseDef.auto_approve === true },
  });

  try {
    return await runWithAgent(agent, ctx, caseDef.prompt, caseDef.system_prompt ?? "");
  } finally {
    await agent.close();
  }
}

async function runWithAgent(
  agent: MiniAgent,
  ctx: CaseContext,
  prompt: string,
  systemPrompt: string,
): Promise<RunTrace> {
  const session = await agent.createSession({ systemPrompt });
  const trace = createTrace();

  for await (const event of agent.run({
    sessionId: session.id,
    message: prompt,
  })) {
    if (event.type === "tool.approval_required" && ctx.autoApprove) {
      ingestRuntimeEvent(trace, event, ctx.log);
      const ok = agent.resolveApproval(event.runId, event.approvalId, "approve");
      if (!ok) throw new Error("resolveApproval returned false");
      ctx.log("approval →", { status: "approve" });
      continue;
    }
    ingestRuntimeEvent(trace, event, ctx.log);
  }
  return trace;
}

export type { RegisteredTool };
