import { MiniAgentClient } from "@mini-agent/sdk";

async function main() {
  const baseUrl = process.env.MINI_AGENT_URL ?? "http://127.0.0.1:8787";
  const apiKey = process.env.MINI_AGENT_API_KEY;
  const client = new MiniAgentClient({ baseUrl, apiKey });

  const session = await client.createSession({
    systemPrompt: "You are a concise assistant. Prefer tools for arithmetic.",
  });
  console.log("session:", session.id);

  const message = process.argv.slice(2).join(" ") || "What is (12 + 30) * 2? Also tell me the current time.";
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
      case "toolResult":
        console.log(
          `tool ← ${event.payload.value.toolName}`,
          event.payload.value.resultJson,
        );
        break;
      case "memoryHit":
        console.log("memory:", event.payload.value.score, event.payload.value.content.slice(0, 80));
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
