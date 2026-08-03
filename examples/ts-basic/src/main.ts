import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { MiniAgentClient } from "@mini-agent/sdk";

for (const path of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]) {
  if (existsSync(path)) {
    loadEnv({ path, override: true });
    break;
  }
}

async function main() {
  const baseUrl = process.env.MINI_AGENT_URL ?? "http://127.0.0.1:8787";
  const apiKey = process.env.MINI_AGENT_API_KEY;
  if (!apiKey) {
    console.error("MINI_AGENT_API_KEY is required (set it in .env or the environment).");
    process.exit(1);
  }

  const autoApproveApprovals =
    process.env.MINI_AGENT_EXAMPLE_AUTO_APPROVE !== "false" &&
    process.env.MINI_AGENT_EXAMPLE_AUTO_APPROVE !== "0";

  const client = new MiniAgentClient({ baseUrl, apiKey });

  const session = await client.createSession({
    systemPrompt: "You are a concise assistant. Prefer tools for arithmetic and file ops.",
  });
  console.log("session:", session.id);

  const message =
    process.argv.slice(2).join(" ") ||
    "What is (12 + 30) * 2? Also tell me the current time.";
  console.log("user:", message);

  for await (const event of client.run({ sessionId: session.id, message })) {
    switch (event.payload.case) {
      case "runStarted":
        console.log(`[run ${event.runId}] started model=${event.payload.value.model}`);
        break;
      case "textDelta":
        console.log("assistant:", event.payload.value.text);
        break;
      case "toolCall":
        console.log(
          `tool → ${event.payload.value.toolName}`,
          event.payload.value.argumentsJson,
        );
        break;
      case "toolResultDelta":
        process.stdout.write(event.payload.value.chunk);
        break;
      case "toolApprovalRequired": {
        const value = event.payload.value;
        console.log(
          `approval? ${value.toolName} risk=${value.risk} reason=${value.reason}`,
          value.argumentsJson,
        );
        if (autoApproveApprovals) {
          const result = await client.resolveToolApproval({
            runId: event.runId,
            approvalId: value.approvalId,
            decision: "approve",
          });
          console.log("approval →", result.status);
        } else {
          console.log("Set MINI_AGENT_EXAMPLE_AUTO_APPROVE=true or call ResolveToolApproval");
        }
        break;
      }
      case "toolResult":
        console.log(
          `tool ← ${event.payload.value.toolName}`,
          event.payload.value.resultJson,
        );
        break;
      case "subagentStarted":
        console.log(
          `subagent ▶ ${event.payload.value.subagentId}`,
          event.payload.value.prompt,
        );
        break;
      case "subagentProgress":
        console.log(
          `subagent … ${event.payload.value.kind}`,
          event.payload.value.toolName || event.payload.value.text?.slice(0, 80),
        );
        break;
      case "subagentCompleted":
        console.log(
          `subagent ■ ${event.payload.value.subagentId}`,
          event.payload.value.isError ? "error" : "ok",
          event.payload.value.finalText.slice(0, 120),
        );
        break;
      case "memoryHit":
        console.log(
          "memory:",
          event.payload.value.score,
          event.payload.value.content.slice(0, 80),
        );
        break;
      case "runCompleted":
        console.log("done:", event.payload.value.finalText);
        break;
      case "runError":
        console.error("error:", event.payload.value.code, event.payload.value.message);
        break;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
