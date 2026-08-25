import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SCREEN_MESSAGE } from "./screen-url.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const EMBED = path.join(dir, "../../../../infra/sandboxes/computer/embed.html");

/**
 * The noVNC page the sandbox serves is plain HTML with one inline module. Rather than
 * asserting on its text, the module is pulled out, its only import is injected, and it runs
 * against a fake RFB — so what is tested is the reconnect behaviour, not the wording.
 */
function runEmbed(options: { expiresAt: number; parent?: boolean; nativeBridge?: boolean }) {
  const html = readFileSync(EMBED, "utf8");
  const script = html
    .replace(/[\s\S]*<script type="module">/, "")
    .replace(/<\/script>[\s\S]*/, "")
    .replace(/^\s*import RFB from "\.\/core\/rfb\.js";\s*$/m, "");

  const handlers: Array<Record<string, (event?: unknown) => void>> = [];
  class FakeRFB {
    viewOnly = false;
    scaleViewport = false;
    clipViewport = false;
    listeners: Record<string, (event?: unknown) => void> = {};
    constructor(
      public target: unknown,
      public url: string,
    ) {
      handlers.push(this.listeners);
    }
    addEventListener(type: string, listener: (event?: unknown) => void) {
      this.listeners[type] = listener;
    }
  }

  const posted: Array<{ payload: unknown; targetOrigin: string }> = [];
  const bridged: string[] = [];
  const pathname = `/novnc/MTI3LjAuMC4x/49152/${options.expiresAt}.sig-a/embed.html`;
  const href = `https://app.example${pathname}?view_only=true`;
  const win: Record<string, unknown> = {
    location: {
      href,
      hash: "",
      pathname,
      protocol: "https:",
      host: "app.example",
      // A sandboxed frame without allow-same-origin has an opaque origin.
      origin: "null",
    },
    ReactNativeWebView: options.nativeBridge
      ? { postMessage: (raw: string) => bridged.push(raw) }
      : undefined,
  };
  win.parent =
    options.parent === false
      ? win
      : {
          postMessage: (payload: unknown, targetOrigin: string) =>
            posted.push({ payload, targetOrigin }),
        };

  const document = {
    location: { href },
    getElementById: () => ({ id: "screen" }),
  };

  const run = new Function("RFB", "window", "document", "setTimeout", "clearTimeout", script);
  const timers: Array<{ fn: () => void; ms: number }> = [];
  run(
    FakeRFB,
    win,
    document,
    (fn: () => void, ms: number) => timers.push({ fn, ms }) - 1,
    () => undefined,
  );

  return {
    posted,
    bridged,
    handlers,
    timers,
    connections: () => handlers.length,
    runTimers() {
      const queued = timers.splice(0, timers.length);
      for (const timer of queued) timer.fn();
    },
    drop(index = handlers.length - 1) {
      handlers[index]?.disconnect?.({ detail: { clean: false } });
    },
    connect(index = handlers.length - 1) {
      handlers[index]?.connect?.({});
    },
  };
}

describe("computer embed page", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  });

  it("connects once on load, view-only as asked", () => {
    const embed = runEmbed({ expiresAt: 1_060_000 });
    expect(embed.connections()).toBe(1);
    expect(embed.posted).toEqual([]);
  });

  it("retries locally while the capability is still valid, then tells the host", () => {
    const embed = runEmbed({ expiresAt: 1_060_000 });
    embed.drop();
    // A blip mid-session: retry here instead of tearing the frame down from outside.
    expect(embed.posted).toEqual([]);
    embed.runTimers();
    expect(embed.connections()).toBe(2);

    embed.drop();
    embed.runTimers();
    expect(embed.connections()).toBe(3);

    // Third drop: local retries are spent, so the host has to mint a new capability.
    embed.drop();
    expect(embed.posted.map((message) => (message.payload as { type: string }).type)).toEqual([
      SCREEN_MESSAGE.disconnected,
    ]);
  });

  it("does not retry against a spent capability — it asks the host straight away", () => {
    const embed = runEmbed({ expiresAt: 1_000_500 });
    embed.drop();
    expect(embed.connections()).toBe(1);
    expect(embed.timers).toEqual([]);
    expect(embed.posted.map((message) => (message.payload as { type: string }).type)).toEqual([
      SCREEN_MESSAGE.disconnected,
    ]);
  });

  it("reports a healthy connection and forgives the earlier drops", () => {
    const embed = runEmbed({ expiresAt: 1_060_000 });
    embed.drop();
    embed.runTimers();
    embed.connect();
    expect(embed.posted.map((message) => (message.payload as { type: string }).type)).toEqual([
      SCREEN_MESSAGE.connected,
    ]);

    // The retry budget is back, so a later blip is handled locally again.
    embed.drop();
    embed.runTimers();
    embed.drop();
    embed.runTimers();
    expect(embed.connections()).toBe(4);
  });

  it("posts to any parent because a sandboxed frame cannot know the app origin", () => {
    const embed = runEmbed({ expiresAt: 1_000_500 });
    embed.drop();
    expect(embed.posted[0]?.targetOrigin).toBe("*");
    // The payload is a plain signal with nothing worth leaking.
    expect(embed.posted[0]?.payload).toEqual({
      type: SCREEN_MESSAGE.disconnected,
      clean: false,
    });
  });

  it("also speaks the React Native bridge, which never sees window.parent messages", () => {
    const embed = runEmbed({ expiresAt: 1_000_500, nativeBridge: true });
    embed.drop();
    expect(embed.bridged.map((raw) => JSON.parse(raw).type)).toEqual([SCREEN_MESSAGE.disconnected]);
  });

  it("stays quiet when it is not embedded at all", () => {
    const embed = runEmbed({ expiresAt: 1_000_500, parent: false });
    expect(() => embed.drop()).not.toThrow();
    expect(embed.posted).toEqual([]);
  });
});

describe("web screen panel wiring", () => {
  const shell = readFileSync(path.join(dir, "../pages/Shell.tsx"), "utf8");

  it("listens for the drop report and remounts with a fresh capability", () => {
    expect(shell).toContain("screenFrameEvent");
    expect(shell).toContain('window.addEventListener("message", onMessage)');
    expect(shell).toContain('window.removeEventListener("message", onMessage)');
    expect(shell).toContain("disconnected: dropped");
    expect(shell).toContain("planScreenReconnect");
  });

  it("backs off, gives up with an honest message, and forgives on a manual open", () => {
    expect(shell).toContain("setScreenLost(true)");
    expect(shell).toContain("A tela caiu e não voltou");
    // Once it gave up it must stop remounting, or the retry budget burns invisibly.
    expect(shell).toContain("if (screenLost) {");
    // bootComputer is the user asking again: the retry budget comes back.
    expect(shell).toContain("screenRetries.current = 0");
    expect(shell.indexOf("screenRetries.current = 0")).toBeLessThan(
      shell.indexOf("const needsBoot = force"),
    );
  });
});
