import { describe, expect, it } from "vitest";
import {
  isRetryableLlmError,
  LLM_MAX_RETRIES,
  LLM_MAX_RETRY_DELAY_MS,
  LLM_TIMEOUT_MS,
  llmStreamOptions,
  withRetry,
  withTimeout,
} from "./llm-retry.js";

describe("LLM timeout and retry", () => {
  it("classifies transient provider failures as retryable", () => {
    expect(isRetryableLlmError(new Error("429 rate limit"))).toBe(true);
    expect(isRetryableLlmError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableLlmError(new Error("Unknown model xyz"))).toBe(false);
  });

  it("retries then succeeds", async () => {
    let n = 0;
    const value = await withRetry(
      async () => {
        n += 1;
        if (n < 2) throw new Error("503 overloaded");
        return "ok";
      },
      { attempts: 2, baseMs: 1 },
    );
    expect(value).toBe("ok");
    expect(n).toBe(2);
  });

  it("times out a hung call", async () => {
    await expect(withTimeout(() => new Promise(() => undefined), 20)).rejects.toThrow(
      /timed out after 20ms/,
    );
  });
});

describe("llmStreamOptions", () => {
  it("adds retry and timeout on top of what the Agent passes, keeping its signal and key", () => {
    const signal = new AbortController().signal;
    expect(llmStreamOptions({ signal, apiKey: "k" })).toEqual({
      signal,
      apiKey: "k",
      maxRetries: LLM_MAX_RETRIES,
      maxRetryDelayMs: LLM_MAX_RETRY_DELAY_MS,
      timeoutMs: LLM_TIMEOUT_MS,
    });
    expect(llmStreamOptions(undefined)).toMatchObject({ maxRetries: 3, timeoutMs: 120_000 });
  });
});
