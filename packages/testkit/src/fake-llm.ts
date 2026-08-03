import { FakeLlmClient, type LlmChatResponse } from "@mini-agent/runtime";
import type { FakeLlmStep } from "./types.js";

export function createFakeLlmFromSteps(steps: FakeLlmStep[] | undefined): FakeLlmClient {
  if (!steps?.length) {
    throw new Error("fake_llm steps are required for unit/e2e modes");
  }
  let index = 0;
  return new FakeLlmClient(async () => {
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
