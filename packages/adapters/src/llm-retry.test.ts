import { describe, expect, it } from "vitest";
import { isRetryableLlmError, withRetry, withTimeout } from "./llm-retry.js";

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
