import { describe, expect, it } from "vitest";
import {
  isRetryableLlmError,
  LLM_MAX_RETRIES,
  LLM_MAX_RETRY_DELAY_MS,
  LLM_TIMEOUT_MS,
  llmStreamOptions,
  withTimeout,
} from "./llm-retry.js";

describe("LLM timeout and retry", () => {
  it("classifies transient provider failures as retryable", () => {
    expect(isRetryableLlmError(new Error("429 rate limit"))).toBe(true);
    expect(isRetryableLlmError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableLlmError(new Error("Unknown model xyz"))).toBe(false);
  });

  it("times out a hung call", async () => {
    await expect(withTimeout(() => new Promise(() => undefined), 20)).rejects.toThrow(
      /timed out after 20ms/,
    );
  });

  it("aborts, and does not blame the provider, when the caller gives up first", async () => {
    const parent = new AbortController();
    const call = withTimeout(() => new Promise(() => undefined), 60_000, parent.signal);
    parent.abort();
    await expect(call).rejects.toThrow(/aborted/);
  });

  it("hands the work a signal that dies with the deadline", async () => {
    let inner: AbortSignal | undefined;
    await expect(
      withTimeout((signal) => {
        inner = signal;
        return new Promise(() => undefined);
      }, 10),
    ).rejects.toThrow(/timed out/);
    expect(inner?.aborted).toBe(true);
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
