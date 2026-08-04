import { isPromptTooLongError } from "../context/estimate.js";

export type LlmErrorKind =
  | "prompt_too_long"
  | "rate_limit"
  | "overloaded"
  | "transient"
  | "fatal"
  | "aborted";

export class LlmHttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly retryAfterMs?: number;

  constructor(input: {
    status: number;
    body: string;
    retryAfterMs?: number;
    message?: string;
  }) {
    super(
      input.message ??
        `LLM request failed (${input.status}): ${input.body.slice(0, 500)}`,
    );
    this.name = "LlmHttpError";
    this.status = input.status;
    this.body = input.body;
    this.retryAfterMs = input.retryAfterMs;
  }
}

export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header?.trim()) return undefined;
  const asInt = Number(header.trim());
  if (Number.isFinite(asInt) && asInt >= 0) {
    return Math.round(asInt * 1000);
  }
  const when = Date.parse(header);
  if (Number.isFinite(when)) {
    return Math.max(0, when - Date.now());
  }
  return undefined;
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  if (name === "AbortError") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /aborted|abort/i.test(message) && /signal|request|fetch|run cancelled/i.test(message);
}

export function classifyLlmError(err: unknown): LlmErrorKind {
  if (isAbortError(err)) return "aborted";
  if (isPromptTooLongError(err)) return "prompt_too_long";

  if (err instanceof LlmHttpError) {
    if (err.status === 429) return "rate_limit";
    if (err.status === 529 || err.status === 503) return "overloaded";
    if (err.status >= 500) return "transient";
    if (err.status === 408) return "transient";
    return "fatal";
  }

  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (/\b429\b/.test(lower) || lower.includes("rate limit") || lower.includes("too many requests")) {
    return "rate_limit";
  }
  if (/\b529\b/.test(lower) || lower.includes("overloaded") || lower.includes("high demand")) {
    return "overloaded";
  }
  if (
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("fetch failed") ||
    lower.includes("network") ||
    lower.includes("socket")
  ) {
    return "transient";
  }
  return "fatal";
}

export function isTransientLlmError(kind: LlmErrorKind): boolean {
  return kind === "rate_limit" || kind === "overloaded" || kind === "transient";
}
