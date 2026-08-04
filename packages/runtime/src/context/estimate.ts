import type { ChatMessage } from "../types.js";

/** Rough token estimate: ~4 chars per token. */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += message.content?.length ?? 0;
    chars += message.name?.length ?? 0;
    chars += message.toolCallId?.length ?? 0;
    if (message.toolCalls) {
      for (const call of message.toolCalls) {
        chars += call.id.length + call.name.length + call.arguments.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

export function isPromptTooLongError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return (
    lower.includes("prompt_too_long") ||
    lower.includes("context_length") ||
    lower.includes("maximum context") ||
    lower.includes("context window") ||
    lower.includes("too many tokens") ||
    /\b413\b/.test(lower)
  );
}

export type CompactLayer = "snip" | "micro" | "budget" | "llm" | "reactive" | "manual";

export interface CompactOptions {
  enabled?: boolean;
  maxMessages?: number;
  keepHeadMessages?: number;
  keepRecentToolResults?: number;
  maxToolResultBytes?: number;
  toolResultPreviewChars?: number;
  autoCompactThreshold?: number;
  maxConsecutiveLlmFailures?: number;
  maxReactiveRetries?: number;
}

export const DEFAULT_COMPACT_OPTIONS: Required<CompactOptions> = {
  enabled: true,
  maxMessages: 50,
  keepHeadMessages: 3,
  keepRecentToolResults: 3,
  maxToolResultBytes: 200_000,
  toolResultPreviewChars: 2000,
  autoCompactThreshold: 100_000,
  maxConsecutiveLlmFailures: 3,
  maxReactiveRetries: 1,
};

export function resolveCompactOptions(
  options?: CompactOptions,
): Required<CompactOptions> {
  return { ...DEFAULT_COMPACT_OPTIONS, ...options };
}
