import type { RecoveryKind } from "./constants.js";
import { MAX_OVERLOADED_BEFORE_FALLBACK } from "./constants.js";
import { retryDelayMs, sleep } from "./backoff.js";
import {
  classifyLlmError,
  isTransientLlmError,
  LlmHttpError,
  type LlmErrorKind,
} from "./errors.js";
import type { RecoveryState } from "./state.js";

export interface TransientRetryMeta {
  kind: RecoveryKind;
  attempt: number;
  delayMs: number;
  model: string;
  errorKind: LlmErrorKind;
  detail?: string;
}

export interface WithTransientRetryInput<T> {
  state: RecoveryState;
  abortSignal?: AbortSignal;
  onRetry?: (meta: TransientRetryMeta) => void | Promise<void>;
  fn: () => Promise<T>;
}

/**
 * Retries transient LLM failures (429 / 529 / network) with backoff.
 * May switch to fallbackModel after consecutive overloaded errors.
 * Non-transient errors are rethrown immediately.
 */
export async function withTransientRetry<T>(
  input: WithTransientRetryInput<T>,
): Promise<T> {
  const { state, abortSignal, onRetry, fn } = input;
  if (!state.options.enabled) {
    return fn();
  }

  const max = state.options.maxTransientRetries;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= max; attempt += 1) {
    if (abortSignal?.aborted) {
      throw abortSignal.reason ?? new Error("Aborted");
    }
    try {
      const result = await fn();
      state.resetTransientCountersOnSuccess();
      return result;
    } catch (err) {
      lastErr = err;
      const errorKind = classifyLlmError(err);
      if (errorKind === "aborted") throw err;
      if (!isTransientLlmError(errorKind)) throw err;
      if (attempt >= max) break;

      if (errorKind === "overloaded") {
        state.consecutiveOverloaded += 1;
      } else {
        state.consecutiveOverloaded = 0;
      }

      const retryAfter =
        err instanceof LlmHttpError ? err.retryAfterMs : undefined;
      const delayMs = retryDelayMs(attempt, retryAfter);
      state.transientAttempt = attempt + 1;

      await onRetry?.({
        kind: "transient_retry",
        attempt: attempt + 1,
        delayMs,
        model: state.currentModel,
        errorKind,
        detail: err instanceof Error ? err.message : String(err),
      });

      await sleep(delayMs, abortSignal);

      if (
        errorKind === "overloaded" &&
        state.consecutiveOverloaded >= MAX_OVERLOADED_BEFORE_FALLBACK &&
        state.options.fallbackModel &&
        state.currentModel !== state.options.fallbackModel
      ) {
        const previous = state.currentModel;
        state.currentModel = state.options.fallbackModel;
        await onRetry?.({
          kind: "fallback_model",
          attempt: attempt + 1,
          delayMs: 0,
          model: state.currentModel,
          errorKind,
          detail: `Switched from ${previous} to ${state.currentModel} due to overloaded errors`,
        });
      }
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error(String(lastErr ?? "Max transient retries exceeded"));
}
