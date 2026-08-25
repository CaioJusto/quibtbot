import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasUsableStartupSession,
  runStartupTask,
  type StartupResult,
  shouldOpenConnectionScreen,
} from "./startup";

afterEach(() => {
  vi.useRealTimers();
});

describe("mobile startup deadline", () => {
  it("returns a successful startup value", async () => {
    await expect(runStartupTask(async () => "ready", 100)).resolves.toEqual({
      ok: true,
      value: "ready",
    });
  });

  it("stops waiting and aborts a stalled operation", async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | undefined;
    const startup = runStartupTask(async (signal) => {
      receivedSignal = signal;
      return new Promise<string>(() => undefined);
    }, 4_000);

    await vi.advanceTimersByTimeAsync(4_000);

    await expect(startup).resolves.toEqual({ ok: false, reason: "timeout" });
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("turns a rejected native operation into an explicit error result", async () => {
    const failure = new Error("keychain unavailable");

    await expect(runStartupTask(async () => Promise.reject(failure), 100)).resolves.toEqual({
      ok: false,
      reason: "error",
      error: failure,
    });
  });

  it("opens the connection screen when there is no stored session", () => {
    expect(hasUsableStartupSession({ ok: true, value: "" })).toBe(false);
    expect(hasUsableStartupSession({ ok: true, value: "session-token" })).toBe(true);
    expect(hasUsableStartupSession({ ok: false, reason: "timeout" })).toBe(false);
  });

  it("falls back only for connection errors or startup deadlines", () => {
    const unavailable: StartupResult<"unavailable"> = { ok: true, value: "unavailable" };
    expect(shouldOpenConnectionScreen(unavailable)).toBe(true);
    expect(shouldOpenConnectionScreen({ ok: false, reason: "timeout" })).toBe(true);
    expect(shouldOpenConnectionScreen({ ok: true, value: "signed-out" })).toBe(false);
    expect(shouldOpenConnectionScreen({ ok: true, value: "ready" })).toBe(false);
  });
});
