/**
 * Shared `IntersectionObserver` so an avatar can stop animating while it is scrolled out
 * of view. One observer serves every mascot: a long inbox has one observer, not one per
 * row. Hosts without `IntersectionObserver` (older webviews, server render) are treated as
 * always visible, so nothing ever freezes by accident.
 */

export type VisibilityEntry = { target: unknown; isIntersecting: boolean };

export type VisibilityObserver = {
  observe: (element: never) => void;
  unobserve: (element: never) => void;
  disconnect: () => void;
};

export type VisibilityTracker = {
  /** Reports visibility changes for `element`. Returns the unsubscribe. */
  observe: (element: unknown, onChange: (visible: boolean) => void) => () => void;
};

export function createVisibilityTracker(
  create: (handle: (entries: readonly VisibilityEntry[]) => void) => VisibilityObserver | null,
): VisibilityTracker {
  const listeners = new Map<unknown, (visible: boolean) => void>();
  let observer: VisibilityObserver | null = null;
  let unsupported = false;

  const handle = (entries: readonly VisibilityEntry[]) => {
    for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting);
  };

  return {
    observe(element, onChange) {
      if (unsupported || !element) {
        onChange(true);
        return () => undefined;
      }
      if (!observer) {
        observer = create(handle);
        if (!observer) {
          unsupported = true;
          onChange(true);
          return () => undefined;
        }
      }
      listeners.set(element, onChange);
      observer.observe(element as never);
      return () => {
        if (!listeners.delete(element)) return;
        observer?.unobserve(element as never);
        if (listeners.size === 0) {
          observer?.disconnect();
          observer = null;
        }
      };
    },
  };
}

export const sharedVisibilityTracker = createVisibilityTracker((handle) => {
  if (typeof IntersectionObserver !== "function") return null;
  // A slack margin keeps a row animating while it is being scrolled into place.
  return new IntersectionObserver((entries) => handle(entries), {
    rootMargin: "120px",
  }) as unknown as VisibilityObserver;
});

export function onVisibilityChange(element: unknown, onChange: (visible: boolean) => void) {
  return sharedVisibilityTracker.observe(element, onChange);
}
