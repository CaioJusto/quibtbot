import { describe, expect, it, vi } from "vitest";
import { createPointerTracker } from "./pointer-tracker.js";

function fakeSource() {
  const listeners = new Set<(event: { clientX: number; clientY: number }) => void>();
  return {
    listeners,
    source: {
      addEventListener: vi.fn((_type: "pointermove", listener: (event: never) => void) => {
        listeners.add(listener as never);
      }),
      removeEventListener: vi.fn((_type: "pointermove", listener: (event: never) => void) => {
        listeners.delete(listener as never);
      }),
    },
    move(clientX: number, clientY: number) {
      for (const listener of [...listeners]) listener({ clientX, clientY });
    },
  };
}

function fakeFrames() {
  let queued: (() => void) | null = null;
  return {
    schedule(callback: () => void) {
      queued = callback;
      return () => {
        queued = null;
      };
    },
    run() {
      const callback = queued;
      queued = null;
      callback?.();
    },
    get pending() {
      return queued !== null;
    },
  };
}

describe("shared pointer tracker", () => {
  it("attaches one listener no matter how many mascots are looking", () => {
    const host = fakeSource();
    const frames = fakeFrames();
    const tracker = createPointerTracker({
      source: () => host.source,
      schedule: frames.schedule,
    });
    tracker.subscribe(() => undefined);
    tracker.subscribe(() => undefined);
    tracker.subscribe(() => undefined);
    expect(host.source.addEventListener).toHaveBeenCalledTimes(1);
    expect(host.listeners.size).toBe(1);
  });

  it("throttles a burst of moves into one delivery per frame", () => {
    const host = fakeSource();
    const frames = fakeFrames();
    const tracker = createPointerTracker({
      source: () => host.source,
      schedule: frames.schedule,
    });
    const seen: Array<{ x: number; y: number }> = [];
    tracker.subscribe((position) => seen.push(position));

    host.move(10, 10);
    host.move(20, 20);
    host.move(30, 40);
    expect(seen).toEqual([]);
    frames.run();
    expect(seen).toEqual([{ x: 30, y: 40 }]);

    host.move(50, 60);
    frames.run();
    expect(seen).toEqual([
      { x: 30, y: 40 },
      { x: 50, y: 60 },
    ]);
  });

  it("gives a mascot mounted mid-sweep the position the pointer is already at", () => {
    const host = fakeSource();
    const frames = fakeFrames();
    const tracker = createPointerTracker({
      source: () => host.source,
      schedule: frames.schedule,
    });
    tracker.subscribe(() => undefined);
    host.move(70, 80);
    frames.run();

    const late = vi.fn();
    tracker.subscribe(late);
    expect(late).toHaveBeenCalledWith({ x: 70, y: 80 });
  });

  it("removes the listener and the queued frame when the last mascot unmounts", () => {
    const host = fakeSource();
    const frames = fakeFrames();
    const tracker = createPointerTracker({
      source: () => host.source,
      schedule: frames.schedule,
    });
    const stopA = tracker.subscribe(() => undefined);
    const stopB = tracker.subscribe(() => undefined);
    host.move(1, 2);

    stopA();
    expect(host.listeners.size).toBe(1);
    stopB();
    expect(host.source.removeEventListener).toHaveBeenCalledTimes(1);
    expect(host.listeners.size).toBe(0);
    expect(frames.pending).toBe(false);
  });

  it("survives a host without a pointer at all", () => {
    const tracker = createPointerTracker({ source: () => null });
    const stop = tracker.subscribe(() => undefined);
    expect(tracker.latest()).toBeNull();
    expect(() => stop()).not.toThrow();
  });
});
