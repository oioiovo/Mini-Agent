import { createAgent } from "@mini-agent/runtime";
import { MiniAgentClient } from "@mini-agent/sdk";
import { createMiniAgentServer } from "@mini-agent/server";
import { createFakeLlmFromSteps } from "../fake-llm.js";
import { createTrace, ingestClientEvent } from "../collect.js";
import { withInterpolatedFakeLlm } from "../interpolate-case.js";
import type { CaseContext, RunTrace } from "../types.js";

export async function runE2eCase(ctx: CaseContext): Promise<RunTrace> {
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

  const server = await createMiniAgentServer({
    host: "127.0.0.1",
    port: 0,
    apiKey: "testkit-key",
    agent,
  });

  const client = new MiniAgentClient({
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiKey: "testkit-key",
  });

  try {
    const session = await client.createSession({
      systemPrompt: caseDef.system_prompt ?? "",
    });
    const trace = createTrace();
    for await (const event of client.run({
      sessionId: session.id,
      message: caseDef.prompt,
    })) {
      await ingestClientEvent(ctx, trace, event, (input) =>
        client.resolveToolApproval(input),
      );
    }
    return trace;
  } finally {
    await server.close();
  }
}
