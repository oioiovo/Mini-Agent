import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { retryDelayMs } from "./backoff.js";
import {
  classifyLlmError,
  LlmHttpError,
  parseRetryAfterMs,
} from "./errors.js";
import { RecoveryState } from "./state.js";
import { withTransientRetry } from "./with-retry.js";

describe("retryDelayMs", () => {
  it("uses Retry-After when provided", () => {
    assert.equal(retryDelayMs(0, 2500, () => 0), 2500);
  });

  it("applies exponential base with jitter bound", () => {
    const d0 = retryDelayMs(0, undefined, () => 0);
    const d1 = retryDelayMs(1, undefined, () => 0);
    assert.equal(d0, 500);
    assert.equal(d1, 1000);
    const withJitter = retryDelayMs(0, undefined, () => 1);
    assert.ok(withJitter >= 500 && withJitter <= 500 * 1.25);
  });

  it("caps at 32000 before jitter", () => {
    const d = retryDelayMs(20, undefined, () => 0);
    assert.equal(d, 32_000);
  });
});

describe("classifyLlmError", () => {
  it("classifies http status codes", () => {
    assert.equal(classifyLlmError(new LlmHttpError({ status: 429, body: "x" })), "rate_limit");
    assert.equal(classifyLlmError(new LlmHttpError({ status: 529, body: "x" })), "overloaded");
    assert.equal(classifyLlmError(new LlmHttpError({ status: 503, body: "x" })), "overloaded");
    assert.equal(classifyLlmError(new LlmHttpError({ status: 500, body: "x" })), "transient");
    assert.equal(classifyLlmError(new LlmHttpError({ status: 400, body: "x" })), "fatal");
  });

  it("detects prompt too long", () => {
    assert.equal(
      classifyLlmError(new Error("context_length_exceeded")),
      "prompt_too_long",
    );
  });

  it("parses Retry-After seconds", () => {
    assert.equal(parseRetryAfterMs("2"), 2000);
  });
});

describe("withTransientRetry", () => {
  it("retries rate limits then succeeds", async () => {
    const state = new RecoveryState({
      model: "primary",
      recovery: { maxTransientRetries: 5 },
    });
    let calls = 0;
    const kinds: string[] = [];
    const result = await withTransientRetry({
      state,
      onRetry: (meta) => {
        kinds.push(meta.kind);
      },
      fn: async () => {
        calls += 1;
        if (calls < 3) {
          throw new LlmHttpError({ status: 429, body: "slow down", retryAfterMs: 1 });
        }
        return "ok";
      },
    });
    assert.equal(result, "ok");
    assert.equal(calls, 3);
    assert.ok(kinds.includes("transient_retry"));
  });

  it("switches to fallback after consecutive overloaded", async () => {
    const state = new RecoveryState({
      model: "primary",
      recovery: {
        maxTransientRetries: 10,
        fallbackModel: "fallback-model",
      },
    });
    let calls = 0;
    const kinds: string[] = [];
    const result = await withTransientRetry({
      state,
      onRetry: (meta) => {
        kinds.push(meta.kind);
      },
      fn: async () => {
        calls += 1;
        if (calls <= 3) {
          throw new LlmHttpError({ status: 529, body: "overloaded", retryAfterMs: 1 });
        }
        assert.equal(state.currentModel, "fallback-model");
        return "ok";
      },
    });
    assert.equal(result, "ok");
    assert.ok(kinds.includes("fallback_model"));
  });

  it("does not retry fatal errors", async () => {
    const state = new RecoveryState({ model: "m" });
    await assert.rejects(
      () =>
        withTransientRetry({
          state,
          fn: async () => {
            throw new LlmHttpError({ status: 400, body: "bad" });
          },
        }),
      /LLM request failed \(400\)/,
    );
  });
});
