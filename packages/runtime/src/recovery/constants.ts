export const DEFAULT_MAX_TOKENS = 8_000;
export const ESCALATED_MAX_TOKENS = 64_000;
export const MAX_CONTINUATIONS = 3;
export const MAX_TRANSIENT_RETRIES = 10;
export const MAX_OVERLOADED_BEFORE_FALLBACK = 3;
export const BASE_DELAY_MS = 500;
export const MAX_DELAY_MS = 32_000;

/** Aligned with Claude Code continuation prompt (s11 / query.ts). */
export const CONTINUATION_PROMPT =
  "Output token limit hit. Resume directly — no apology, no recap of what " +
  "you were doing. Pick up mid-thought if that is where the cut happened. " +
  "Break remaining work into smaller pieces.";

export type RecoveryKind =
  | "max_tokens_escalate"
  | "max_tokens_continuation"
  | "reactive_compact"
  | "transient_retry"
  | "fallback_model";

export interface RecoveryOptions {
  enabled?: boolean;
  defaultMaxTokens?: number;
  escalatedMaxTokens?: number;
  maxContinuations?: number;
  maxTransientRetries?: number;
  /** Fallback model after repeated overloaded errors; else MINI_AGENT_FALLBACK_MODEL. */
  fallbackModel?: string;
}

export function resolveRecoveryOptions(
  options: RecoveryOptions = {},
): Required<Omit<RecoveryOptions, "fallbackModel">> & { fallbackModel: string } {
  const fromEnv = process.env.MINI_AGENT_FALLBACK_MODEL?.trim() ?? "";
  return {
    enabled: options.enabled !== false,
    defaultMaxTokens: options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
    escalatedMaxTokens: options.escalatedMaxTokens ?? ESCALATED_MAX_TOKENS,
    maxContinuations: options.maxContinuations ?? MAX_CONTINUATIONS,
    maxTransientRetries: options.maxTransientRetries ?? MAX_TRANSIENT_RETRIES,
    fallbackModel: options.fallbackModel?.trim() || fromEnv,
  };
}
