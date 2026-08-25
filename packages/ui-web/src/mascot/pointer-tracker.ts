import { nextAnimationFrame } from "./frame-loop.js";

/**
 * One `pointermove` listener for every mascot on the page, throttled to one delivery per
 * frame. Each avatar used to attach its own unthrottled listener, so a pointer sweep over
 * an inbox with thirty bots ran thirty handlers per move event — each one measuring a box
 * and setting state.
 */

export type PointerPosition = { x: number; y: number };

type PointerSource = {
  addEventListener: (
    type: "pointermove",
    listener: (event: { clientX: number; clientY: number }) => void,
    options?: { passive?: boolean },
  ) => void;
  removeEventListener: (
    type: "pointermove",
    listener: (event: { clientX: number; clientY: number }) => void,
  ) => void;
};

export type PointerTracker = {
  /** Calls `callback` with the pointer position, at most once per frame. */
  subscribe: (callback: (position: PointerPosition) => void) => () => void;
  /** Last position seen, or null before the pointer moved. */
  latest: () => PointerPosition | null;
};

export function createPointerTracker(input: {
  source: () => PointerSource | null;
  schedule?: (callback: () => void) => () => void;
}): PointerTracker {
  const schedule = input.schedule ?? ((callback) => nextAnimationFrame(() => callback()));
  const subscribers = new Set<(position: PointerPosition) => void>();
  let latest: PointerPosition | null = null;
  let source: PointerSource | null = null;
  let cancelFlush: (() => void) | null = null;

  const flush = () => {
    cancelFlush = null;
    if (!latest) return;
    const position = latest;
    for (const callback of [...subscribers]) {
      if (subscribers.has(callback)) callback(position);
    }
  };

  const onMove = (event: { clientX: number; clientY: number }) => {
    latest = { x: event.clientX, y: event.clientY };
    // Coalesce a burst of moves into the single frame that will paint them.
    if (!cancelFlush) cancelFlush = schedule(flush);
  };

  const detach = () => {
    source?.removeEventListener("pointermove", onMove);
    source = null;
    cancelFlush?.();
    cancelFlush = null;
  };

  return {
    subscribe(callback) {
      subscribers.add(callback);
      if (!source) {
        source = input.source();
        source?.addEventListener("pointermove", onMove, { passive: true });
      }
      // A mascot mounted mid-sweep should look where the pointer already is.
      if (latest) callback(latest);
      return () => {
        if (!subscribers.delete(callback)) return;
        if (subscribers.size === 0) detach();
      };
    },
    latest: () => latest,
  };
}

export const sharedPointerTracker = createPointerTracker({
  source: () => (typeof window === "undefined" ? null : (window as unknown as PointerSource)),
});

export function onPointerMove(callback: (position: PointerPosition) => void) {
  return sharedPointerTracker.subscribe(callback);
}
