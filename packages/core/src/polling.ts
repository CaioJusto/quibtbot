export type PollingOptions = {
  immediate?: boolean;
  onError?: (error: unknown) => void;
};

/** Runs one poll at a time and waits `intervalMs` after completion before the next one. */
export function startPolling(
  task: () => void | Promise<void>,
  intervalMs: number,
  options: PollingOptions = {},
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => void run(), intervalMs);
  };
  const run = async () => {
    if (stopped) return;
    try {
      await task();
    } catch (error) {
      try {
        options.onError?.(error);
      } catch {
        // Error reporting must not break the scheduler or create an unhandled rejection.
      }
    } finally {
      schedule();
    }
  };

  if (options.immediate) void run();
  else schedule();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
