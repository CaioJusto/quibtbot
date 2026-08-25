import { describe, expect, it, vi } from "vitest";
import { createVisibilityTracker, type VisibilityEntry } from "./visibility.js";

function fakeObserver() {
  let handle: ((entries: readonly VisibilityEntry[]) => void) | null = null;
  const observed = new Set<unknown>();
  const observer = {
    observe: vi.fn((element: unknown) => {
      observed.add(element);
    }),
    unobserve: vi.fn((element: unknown) => {
      observed.delete(element);
    }),
    disconnect: vi.fn(() => {
      observed.clear();
    }),
  };
  const create = vi.fn((next: (entries: readonly VisibilityEntry[]) => void) => {
    handle = next;
    return observer as never;
  });
  return {
    create,
    observer,
    observed,
    emit(entries: VisibilityEntry[]) {
      handle?.(entries);
    },
  };
}

describe("shared visibility tracker", () => {
  it("uses one observer for every mascot on the page", () => {
    const host = fakeObserver();
    const tracker = createVisibilityTracker(host.create);
    tracker.observe({ id: "a" }, () => undefined);
    tracker.observe({ id: "b" }, () => undefined);
    expect(host.create).toHaveBeenCalledTimes(1);
    expect(host.observer.observe).toHaveBeenCalledTimes(2);
  });

  it("reports each element's own visibility", () => {
    const host = fakeObserver();
    const tracker = createVisibilityTracker(host.create);
    const a = { id: "a" };
    const b = { id: "b" };
    const onA = vi.fn();
    const onB = vi.fn();
    tracker.observe(a, onA);
    tracker.observe(b, onB);

    host.emit([
      { target: a, isIntersecting: false },
      { target: b, isIntersecting: true },
    ]);
    expect(onA).toHaveBeenCalledWith(false);
    expect(onB).toHaveBeenCalledWith(true);
  });

  it("stops observing an element that unmounts and drops the observer with the last one", () => {
    const host = fakeObserver();
    const tracker = createVisibilityTracker(host.create);
    const a = { id: "a" };
    const b = { id: "b" };
    const onA = vi.fn();
    const stopA = tracker.observe(a, onA);
    const stopB = tracker.observe(b, () => undefined);

    stopA();
    expect(host.observer.unobserve).toHaveBeenCalledTimes(1);
    host.emit([{ target: a, isIntersecting: true }]);
    expect(onA).not.toHaveBeenCalled();

    stopB();
    expect(host.observer.disconnect).toHaveBeenCalledTimes(1);
  });

  it("treats a host without IntersectionObserver as always visible", () => {
    const tracker = createVisibilityTracker(() => null);
    const onChange = vi.fn();
    const stop = tracker.observe({ id: "a" }, onChange);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(() => stop()).not.toThrow();
  });

  it("treats a missing element as visible instead of freezing it", () => {
    const host = fakeObserver();
    const tracker = createVisibilityTracker(host.create);
    const onChange = vi.fn();
    tracker.observe(null, onChange);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(host.create).not.toHaveBeenCalled();
  });
});
