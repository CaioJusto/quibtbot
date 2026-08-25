import { afterEach, describe, expect, it, vi } from "vitest";
import { startPolling } from "./polling.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("startPolling", () => {
  it("never overlaps requests and schedules from completion", async () => {
    vi.useFakeTimers();
    let finishFirst: (() => void) | undefined;
    const task = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => (finishFirst = resolve)))
      .mockResolvedValue(undefined);
    const stop = startPolling(task, 1000, { immediate: true });

    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(task).toHaveBeenCalledTimes(1);
    finishFirst?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(999);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(2);
    stop();
  });

  it("reports errors and continues until stopped", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const task = vi.fn().mockRejectedValue(new Error("offline"));
    const stop = startPolling(task, 1000, { immediate: true, onError });
    await Promise.resolve();
    expect(onError).toHaveBeenCalledOnce();
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(task).toHaveBeenCalledOnce();
  });
});
