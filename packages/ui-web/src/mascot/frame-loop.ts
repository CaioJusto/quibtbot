/**
 * One `requestAnimationFrame` loop for every mascot on the page.
 *
 * Each avatar used to own a loop (the face engine) plus another one for the idle wander,
 * so an inbox with thirty bots woke the browser sixty times per frame. They all read the
 * same clock, so a single loop fanning out to subscribers draws exactly the same frames.
 */

export type FrameCallback = (now: number) => void;

export type FrameScheduler = {
  request: (callback: (now: number) => void) => number;
  cancel: (handle: number) => void;
};

export type FrameLoop = {
  /** Runs `callback` once per frame until the returned unsubscribe is called. */
  subscribe: (callback: FrameCallback) => () => void;
  /** How many callbacks the loop is driving; the loop is idle at zero. */
  readonly size: number;
};

export function createFrameLoop(scheduler: FrameScheduler): FrameLoop {
  const callbacks = new Set<FrameCallback>();
  let handle: number | null = null;

  const tick = (now: number) => {
    // Queue the next frame before drawing so an unsubscribe inside a callback still
    // cancels the frame it can see.
    handle = callbacks.size ? scheduler.request(tick) : null;
    for (const callback of [...callbacks]) {
      if (!callbacks.has(callback)) continue;
      callback(now);
    }
  };

  return {
    subscribe(callback: FrameCallback) {
      callbacks.add(callback);
      if (handle === null) handle = scheduler.request(tick);
      return () => {
        if (!callbacks.delete(callback)) return;
        if (callbacks.size === 0 && handle !== null) {
          scheduler.cancel(handle);
          handle = null;
        }
      };
    },
    get size() {
      return callbacks.size;
    },
  };
}

const browserScheduler: FrameScheduler = {
  request: (callback) => {
    if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback);
    // Server render / test host: a timer keeps the contract without a browser clock.
    return setTimeout(() => callback(Date.now()), 16) as unknown as number;
  },
  cancel: (handle) => {
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
    else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  },
};

export const sharedFrameLoop = createFrameLoop(browserScheduler);

/** Subscribes to the shared loop. Returns the unsubscribe. */
export function onAnimationFrame(callback: FrameCallback) {
  return sharedFrameLoop.subscribe(callback);
}

/** Runs `callback` on the next frame only. Returns a cancel. */
export function nextAnimationFrame(callback: FrameCallback) {
  const stop = sharedFrameLoop.subscribe((now) => {
    stop();
    callback(now);
  });
  return stop;
}
