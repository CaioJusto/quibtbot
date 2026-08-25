import { afterEach, describe, expect, it, vi } from "vitest";
import { startLiveFeed } from "./live-feed.js";

afterEach(() => {
  vi.useRealTimers();
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("startLiveFeed", () => {
  it("reconnects with backoff after the stream ends and polls while it is down", async () => {
    vi.useFakeTimers();
    const streams = [deferred(), deferred(), deferred()];
    let index = 0;
    const connect = vi.fn(() => streams[index++]?.promise ?? new Promise<void>(() => undefined));
    const refresh = vi.fn().mockResolvedValue(undefined);
    const feed = startLiveFeed({ connect, refresh, pollIntervalMs: 500, minBackoffMs: 1000 });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();

    // Server closes the stream cleanly: catch up right away and poll until the retry.
    streams[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(2);

    // Second failure doubles the delay and polling stops once the stream is back.
    streams[1]!.reject(new Error("offline"));
    await vi.advanceTimersByTimeAsync(0);
    const refreshesBefore = refresh.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1999);
    expect(connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(refresh.mock.calls.length).toBeGreaterThan(refreshesBefore);
    const refreshesWhileLive = refresh.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledTimes(refreshesWhileLive);

    feed.stop();
  });

  it("resets the backoff after a healthy stream", async () => {
    vi.useFakeTimers();
    let stream = deferred();
    const connect = vi.fn(() => {
      stream = deferred();
      return stream.promise;
    });
    const feed = startLiveFeed({
      connect,
      refresh: async () => undefined,
      minBackoffMs: 1000,
      healthyAfterMs: 5000,
    });
    stream.reject(new Error("first"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledTimes(2);
    // Stream lives long enough to count as healthy, then drops.
    await vi.advanceTimersByTimeAsync(6000);
    stream.resolve();
    await vi.advanceTimersByTimeAsync(999);
    expect(connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(3);
    feed.stop();
  });

  it("aborts the stream on stop and never reconnects", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const connect = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    });
    const refresh = vi.fn().mockResolvedValue(undefined);
    const feed = startLiveFeed({ connect, refresh });
    feed.stop();
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("pauses without reconnecting and resumes with a fresh stream", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const connect = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    });
    const refresh = vi.fn().mockResolvedValue(undefined);
    const feed = startLiveFeed({ connect, refresh });
    feed.pause();
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    feed.resume();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(signals[1]?.aborted).toBe(false);
    feed.stop();
    expect(signals[1]?.aborted).toBe(true);
  });

  it("reports connect errors without stopping", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const connect = vi.fn().mockRejectedValue(new Error("boom"));
    const feed = startLiveFeed({
      connect,
      refresh: async () => undefined,
      onError,
      minBackoffMs: 100,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }));
    await vi.advanceTimersByTimeAsync(100);
    expect(connect).toHaveBeenCalledTimes(2);
    feed.stop();
  });
});

describe("live feed status", () => {
  it("only says connected after the stream opens, and offline after repeated failures", async () => {
    vi.useFakeTimers();
    const streams = [deferred(), deferred(), deferred(), deferred()];
    let index = 0;
    let openStream: (() => void) | undefined;
    const connect = vi.fn((_signal: AbortSignal, opened: () => void) => {
      openStream = opened;
      return streams[index++]?.promise ?? new Promise<void>(() => undefined);
    });
    const seen: string[] = [];
    const feed = startLiveFeed({
      connect,
      refresh: vi.fn().mockResolvedValue(undefined),
      minBackoffMs: 1000,
      pollIntervalMs: 500,
      onStatus: (status) => seen.push(status),
    });

    expect(feed.status()).toBe("connecting");
    expect(seen).toEqual([]);

    openStream?.();
    expect(seen).toEqual(["connected"]);

    // Primeira e segunda queda avisam "reconectando"; a terceira já é "sem contato".
    streams[0]!.reject(new Error("caiu"));
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.status()).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1000);
    streams[1]!.reject(new Error("caiu"));
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.status()).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(2000);
    streams[2]!.reject(new Error("caiu"));
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.status()).toBe("offline");

    // Voltar a abrir limpa o aviso, sem repetir o mesmo estado.
    await vi.advanceTimersByTimeAsync(4000);
    openStream?.();
    expect(feed.status()).toBe("connected");
    expect(seen).toEqual(["connected", "reconnecting", "offline", "connected"]);

    feed.stop();
  });

  it("keeps working for a caller that never reports the stream as open", async () => {
    vi.useFakeTimers();
    const stream = deferred();
    const connect = vi.fn(() => stream.promise);
    const feed = startLiveFeed({
      connect,
      refresh: vi.fn().mockResolvedValue(undefined),
      minBackoffMs: 1000,
    });
    expect(feed.status()).toBe("connecting");
    stream.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.status()).toBe("reconnecting");
    feed.stop();
  });
});
