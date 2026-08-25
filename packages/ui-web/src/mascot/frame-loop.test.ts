import { describe, expect, it, vi } from "vitest";
import { createFrameLoop, type FrameScheduler } from "./frame-loop.js";

function fakeScheduler() {
  let next = 1;
  const pending = new Map<number, (now: number) => void>();
  const scheduler: FrameScheduler = {
    request: vi.fn((callback) => {
      const handle = next++;
      pending.set(handle, callback);
      return handle;
    }),
    cancel: vi.fn((handle) => {
      pending.delete(handle);
    }),
  };
  return {
    scheduler,
    get pending() {
      return pending.size;
    },
    frame(now: number) {
      const queued = [...pending.entries()];
      pending.clear();
      for (const [, callback] of queued) callback(now);
    },
  };
}

describe("shared frame loop", () => {
  it("drives many subscribers with a single requestAnimationFrame", () => {
    const host = fakeScheduler();
    const loop = createFrameLoop(host.scheduler);
    const seen: string[] = [];
    loop.subscribe(() => seen.push("a"));
    loop.subscribe(() => seen.push("b"));
    loop.subscribe(() => seen.push("c"));

    expect(host.scheduler.request).toHaveBeenCalledTimes(1);
    host.frame(16);
    expect(seen).toEqual(["a", "b", "c"]);
    // One frame queued for the next tick, not one per subscriber.
    expect(host.pending).toBe(1);
  });

  it("stops the loop when the last subscriber leaves and restarts on the next one", () => {
    const host = fakeScheduler();
    const loop = createFrameLoop(host.scheduler);
    const first = loop.subscribe(() => undefined);
    const second = loop.subscribe(() => undefined);

    first();
    expect(host.scheduler.cancel).not.toHaveBeenCalled();
    second();
    expect(host.scheduler.cancel).toHaveBeenCalledTimes(1);
    expect(host.pending).toBe(0);
    expect(loop.size).toBe(0);

    loop.subscribe(() => undefined);
    expect(host.scheduler.request).toHaveBeenCalledTimes(2);
  });

  it("does not call a subscriber that unsubscribed earlier in the same frame", () => {
    const host = fakeScheduler();
    const loop = createFrameLoop(host.scheduler);
    const later = vi.fn();
    let stopLater: (() => void) | null = null;
    loop.subscribe(() => stopLater?.());
    stopLater = loop.subscribe(later);

    host.frame(16);
    expect(later).not.toHaveBeenCalled();
  });

  it("keeps running for the remaining subscribers after one leaves mid-frame", () => {
    const host = fakeScheduler();
    const loop = createFrameLoop(host.scheduler);
    const survivor = vi.fn();
    const stop = loop.subscribe(() => stop());
    loop.subscribe(survivor);

    host.frame(16);
    expect(survivor).toHaveBeenCalledTimes(1);
    host.frame(32);
    expect(survivor).toHaveBeenCalledTimes(2);
  });
});
