import { FakeLlmClient, type LlmChatRequest, type LlmChatResponse } from "@mini-agent/runtime";
import type { FakeLlmStep } from "./types.js";

/** Side-query prompts used by durable file memory (select / extract / consolidate). */
function isMemorySideQuery(request: LlmChatRequest): boolean {
  const system = request.messages.find((m) => m.role === "system")?.content ?? "";
  return (
    system.includes("Select relevant durable memory") ||
    system.includes("Extract durable") ||
    system.includes("Consolidate durable memories")
  );
}

export function createFakeLlmFromSteps(steps: FakeLlmStep[] | undefined): FakeLlmClient {
  if (!steps?.length) {
    throw new Error("fake_llm steps are required for unit/e2e modes");
  }
  let index = 0;
  return new FakeLlmClient(async (request) => {
    if (isMemorySideQuery(request)) {
      const response: LlmChatResponse = {
        finishReason: "stop",
        message: { role: "assistant", content: "[]" },
      };
      return response;
    }
    if (index >= steps.length) {
      throw new Error(`FakeLlm ran out of scripted steps (need step ${index + 1})`);
    }
    const step = steps[index++]!;
    if (step.tool_calls?.length) {
      const response: LlmChatResponse = {
        finishReason: "tool_calls",
        message: {
          role: "assistant",
          content: step.content ?? "",
          toolCalls: step.tool_calls.map((call, i) => ({
            id: `fake_${index}_${i}`,
            name: call.name,
            arguments:
              typeof call.arguments === "string"
                ? call.arguments
                : JSON.stringify(call.arguments ?? {}),
          })),
        },
      };
      return response;
    }
    return {
      finishReason: "stop",
      message: {
        role: "assistant",
        content: step.content ?? "",
      },
    };
  });
}
