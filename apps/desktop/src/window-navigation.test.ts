import { describe, expect, it, vi } from "vitest";
import { NAVIGATION_TIMEOUT_MS, waitForWebContentsLoad } from "./window-navigation.js";

type Listener = (...args: unknown[]) => void;

function mockContents(loadImpl: () => Promise<void>) {
  const listeners: Record<string, Listener[]> = {};
  return {
    once(event: string, listener: Listener) {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(listener);
    },
    removeListener(event: string, listener: Listener) {
      const bucket = listeners[event];
      if (!bucket) return;
      listeners[event] = bucket.filter((item) => item !== listener);
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners[event] ?? []) listener(...args);
    },
    loadURL: vi.fn(loadImpl),
    loadFile: vi.fn(loadImpl),
  };
}

describe("waitForWebContentsLoad", () => {
  it("resolves exactly once on did-finish-load", async () => {
    const contents = mockContents(async () => undefined);
    const promise = waitForWebContentsLoad(
      contents,
      () => true,
      () => contents.loadURL("http://127.0.0.1:5173"),
    );
    contents.emit("did-finish-load");
    await expect(promise).resolves.toBeUndefined();
    expect(contents.loadURL).toHaveBeenCalledOnce();
  });

  it("rejects exactly once on did-fail-load with bounded timeout message", async () => {
    const contents = mockContents(async () => undefined);
    const promise = waitForWebContentsLoad(
      contents,
      () => true,
      () => contents.loadURL("http://127.0.0.1:5173"),
    );
    contents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "http://127.0.0.1:5173", true);
    await expect(promise).rejects.toThrow(/Falha ao carregar/);
  });

  it("rejects on load promise rejection without double-settling", async () => {
    const contents = mockContents(async () => {
      throw new Error("loadURL rejected");
    });
    await expect(
      waitForWebContentsLoad(
        contents,
        () => true,
        () => contents.loadURL("http://127.0.0.1:5173"),
      ),
    ).rejects.toThrow("loadURL rejected");
  });

  it("rejects when navigation is no longer current", async () => {
    const contents = mockContents(async () => undefined);
    const promise = waitForWebContentsLoad(
      contents,
      () => false,
      () => contents.loadURL("http://127.0.0.1:5173"),
      50,
    );
    contents.emit("did-finish-load");
    await expect(promise).rejects.toThrow("Navegação cancelada.");
  });

  it("ignores subframe did-fail-load and still resolves on main finish", async () => {
    const contents = mockContents(async () => undefined);
    const promise = waitForWebContentsLoad(
      contents,
      () => true,
      () => contents.loadURL("http://127.0.0.1:5173"),
    );
    contents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "http://127.0.0.1:5173/ads", false);
    contents.emit("did-finish-load");
    await expect(promise).resolves.toBeUndefined();
  });

  it("times out with a bounded error when nothing fires", async () => {
    const contents = mockContents(async () => undefined);
    await expect(
      waitForWebContentsLoad(
        contents,
        () => true,
        () => contents.loadURL("http://127.0.0.1:5173"),
        40,
      ),
    ).rejects.toThrow(/tempo limite/i);
    expect(NAVIGATION_TIMEOUT_MS).toBeGreaterThan(1000);
  });
});
