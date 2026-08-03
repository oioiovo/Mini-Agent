import type { CaseDef, FakeLlmStep } from "./types.js";
import { interpolate } from "./schema.js";

export function interpolateFakeLlm(
  steps: FakeLlmStep[] | undefined,
  vars: Record<string, string>,
): FakeLlmStep[] | undefined {
  if (!steps) return steps;
  return steps.map((step) => ({
    content: step.content !== undefined ? interpolate(step.content, vars) : undefined,
    tool_calls: step.tool_calls?.map((call) => ({
      name: call.name,
      arguments:
        typeof call.arguments === "string"
          ? interpolate(call.arguments, vars)
          : call.arguments
            ? JSON.parse(interpolate(JSON.stringify(call.arguments), vars))
            : {},
    })),
  }));
}

export function withInterpolatedFakeLlm(caseDef: CaseDef, vars: Record<string, string>): CaseDef {
  return {
    ...caseDef,
    fake_llm: interpolateFakeLlm(caseDef.fake_llm, vars),
    prompt: interpolate(caseDef.prompt, vars),
  };
}
