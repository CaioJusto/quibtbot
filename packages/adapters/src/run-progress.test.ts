import { describe, expect, it } from "vitest";
import { createProgressThrottle, PROGRESS_INTERVAL_MS } from "./run-progress.js";

describe("streaming progress throttle", () => {
  it("publishes the first token immediately", () => {
    const progress = createProgressThrottle();
    expect(progress.shouldPublish("Oi", 1_000)).toBe(true);
  });

  it("collapses a burst of tokens into one event per interval", () => {
    const progress = createProgressThrottle(400);
    expect(progress.shouldPublish("a", 0)).toBe(true);
    expect(progress.shouldPublish("ab", 80)).toBe(false);
    expect(progress.shouldPublish("abc", 200)).toBe(false);
    expect(progress.shouldPublish("abcd", 401)).toBe(true);
  });

  it("skips empty text and text that did not change", () => {
    const progress = createProgressThrottle(400);
    expect(progress.shouldPublish("   ", 0)).toBe(false);
    expect(progress.shouldPublish("a", 0)).toBe(true);
    expect(progress.shouldPublish("a", 5_000)).toBe(false);
  });

  it("stays far cheaper than one event per 80 ms tick", () => {
    expect(PROGRESS_INTERVAL_MS).toBeGreaterThanOrEqual(400);
  });
});
