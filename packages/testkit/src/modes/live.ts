import { MiniAgentClient } from "@mini-agent/sdk";
import { createTrace, ingestClientEvent } from "../collect.js";
import { interpolate } from "../schema.js";
import type { CaseContext, RunTrace } from "../types.js";

export async function runLiveCase(ctx: CaseContext): Promise<RunTrace> {
  const baseUrl = process.env.MINI_AGENT_URL ?? "http://127.0.0.1:8787";
  const apiKey = process.env.MINI_AGENT_API_KEY;
  if (!apiKey) throw new Error("MINI_AGENT_API_KEY is required for live mode");

  ctx.log("live.connect", { baseUrl });
  const client = new MiniAgentClient({ baseUrl, apiKey });
  const prompt = interpolate(ctx.caseDef.prompt, ctx.vars);
  const session = await client.createSession({
    systemPrompt: ctx.caseDef.system_prompt ?? "",
  });
  const trace = createTrace();
  for await (const event of client.run({
    sessionId: session.id,
    message: prompt,
  })) {
    await ingestClientEvent(ctx, trace, event, (input) =>
      client.resolveToolApproval(input),
    );
  }
  return trace;
}
