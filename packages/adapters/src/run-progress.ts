/**
 * Streaming publishes one cumulative `thread.progress` event, so the payload shape the web
 * and mobile clients read never changes here — only how often it is written. Every event is
 * a transaction with an advisory lock plus a NOTIFY, so an 80 ms cadence made a long answer
 * cost hundreds of writes.
 */
export const PROGRESS_INTERVAL_MS = 400;

export interface ProgressThrottle {
  /** True when this tick is worth an event; marks it published. */
  shouldPublish(text: string, now: number): boolean;
}

export function createProgressThrottle(
  intervalMs: number = PROGRESS_INTERVAL_MS,
): ProgressThrottle {
  let lastAt = 0;
  let lastText = "";
  let published = false;
  return {
    shouldPublish(text, now) {
      if (!text.trim()) return false;
      if (text === lastText) return false;
      if (published && now - lastAt < intervalMs) return false;
      published = true;
      lastAt = now;
      lastText = text;
      return true;
    },
  };
}
