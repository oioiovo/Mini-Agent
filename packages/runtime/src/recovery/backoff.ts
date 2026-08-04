import { BASE_DELAY_MS, MAX_DELAY_MS } from "./constants.js";

/**
 * Exponential backoff with jitter (s11 / CC withRetry):
 * min(500 * 2^attempt, 32000) + random(0..25%).
 * Prefer server Retry-After when provided.
 */
export function retryDelayMs(
  attempt: number,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  if (retryAfterMs != null && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.round(retryAfterMs);
  }
  const exp = Math.max(0, attempt);
  const base = Math.min(BASE_DELAY_MS * 2 ** exp, MAX_DELAY_MS);
  const jitter = random() * base * 0.25;
  return Math.round(base + jitter);
}

export function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(abortSignal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortSignal?.reason ?? new Error("Aborted"));
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}
