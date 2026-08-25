/** Polling that a closed overlay or unmounted screen can actually stop. */

export type ConnectionPollResult = "connected" | "timeout" | "cancelled";

/**
 * Waits for an OAuth connection to land. The caller owns `cancelled`, so leaving
 * the plugins screen stops the loop instead of hammering the API for another
 * minute and a half.
 */
export async function pollForConnection(input: {
  attempts: number;
  delayMs: number;
  check: () => Promise<{ status?: string } | undefined>;
  wait?: (ms: number) => Promise<void>;
  cancelled?: () => boolean;
}): Promise<ConnectionPollResult> {
  const wait = input.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const cancelled = input.cancelled ?? (() => false);
  for (let i = 0; i < input.attempts; i += 1) {
    if (cancelled()) return "cancelled";
    const row = await input.check().catch(() => undefined);
    if (cancelled()) return "cancelled";
    if (row?.status === "connected") return "connected";
    await wait(input.delayMs);
  }
  return cancelled() ? "cancelled" : "timeout";
}
