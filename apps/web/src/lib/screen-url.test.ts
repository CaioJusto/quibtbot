import { describe, expect, it } from "vitest";
import {
  decideScreenUrl,
  embeddableScreenUrl,
  planScreenReconnect,
  SCREEN_MESSAGE,
  SCREEN_RECONNECT_BASE_MS,
  SCREEN_RECONNECT_LIMIT,
  SCREEN_RECONNECT_MAX_MS,
  SCREEN_URL_RENEW_MARGIN_MS,
  screenFrameEvent,
  screenIframeSandbox,
  screenUrlCapability,
  screenUrlRemainingMs,
  shouldFetchScreenUrl,
} from "./screen-url.js";

const NOW = 1_700_000_000_000;

function signed(expiresAt: number, signature = "sig-a", port = 49152, path = "/embed.html") {
  return `https://app.example/novnc/MTI3LjAuMC4x/${port}/${expiresAt}.${signature}${path}`;
}

function signedMode(
  expiresAt: number,
  mode: "view" | "control",
  signature = "sig-a",
  port = 49152,
  path = "/embed.html?view_only=false",
) {
  return `https://app.example/novnc/MTI3LjAuMC4x/${port}/${expiresAt}.${signature}.${mode}${path}`;
}

describe("screen capability", () => {
  it("reads the expiry and ignores the signature when identifying the screen", () => {
    const capability = screenUrlCapability(signed(NOW + 60_000, "sig-a"));
    expect(capability?.expiresAt).toBe(NOW + 60_000);
    expect(capability?.target).toBe("https://app.example/MTI3LjAuMC4x/49152/embed.html");
    expect(screenUrlCapability(signed(NOW + 1, "sig-b"))?.target).toBe(capability?.target);
  });

  it("treats an unsigned URL as one that never expires by itself", () => {
    expect(screenUrlCapability("http://127.0.0.1:6080/vnc.html")).toBeNull();
    expect(screenUrlRemainingMs("http://127.0.0.1:6080/vnc.html", NOW)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("reads a capability that carries a signed view/control mode", () => {
    const capability = screenUrlCapability(signedMode(NOW + 60_000, "control", "sig-a"));
    expect(capability?.expiresAt).toBe(NOW + 60_000);
    expect(capability?.target).toBe(
      "https://app.example/MTI3LjAuMC4x/49152.control/embed.html?view_only=false",
    );
    expect(screenUrlCapability(signedMode(NOW + 1, "control", "sig-b"))?.target).toBe(
      capability?.target,
    );
    expect(screenUrlCapability(signedMode(NOW + 60_000, "view", "sig-a"))?.target).not.toBe(
      capability?.target,
    );
  });
});

describe("decideScreenUrl", () => {
  it("keeps the mounted iframe on its URL when a refresh re-signs the same screen", () => {
    const current = signed(NOW + 60_000, "sig-a");
    const next = signed(NOW + 120_000, "sig-b");
    expect(decideScreenUrl({ current, next, mountedAt: NOW - 5_000, now: NOW + 30_000 })).toEqual({
      url: current,
      action: "keep",
    });
  });

  it("keeps the mounted iframe when a refresh re-signs the same control capability", () => {
    const current = signedMode(NOW + 60_000, "control", "sig-a");
    const next = signedMode(NOW + 120_000, "control", "sig-b");
    expect(decideScreenUrl({ current, next, mountedAt: NOW - 5_000, now: NOW + 30_000 })).toEqual({
      url: current,
      action: "keep",
    });
  });

  it("unpins a mounted iframe when the API stops issuing a capability", () => {
    const current = signedMode(NOW + 60_000, "control", "sig-a");
    expect(decideScreenUrl({ current, next: null, mountedAt: NOW, now: NOW + 1_000 })).toEqual({
      url: null,
      action: "reconnect",
    });
  });

  it("swaps when the signed mode changes from view to control", () => {
    const current = signedMode(NOW + 60_000, "view", "sig-a", 49152, "/embed.html?view_only=true");
    const next = signedMode(NOW + 60_000, "control", "sig-b");
    expect(decideScreenUrl({ current, next, mountedAt: NOW, now: NOW + 1_000 })).toEqual({
      url: next,
      action: "swap",
    });
  });

  it("keeps the mounted iframe even after its capability expired — the socket is already open", () => {
    const current = signed(NOW + 60_000, "sig-a");
    const next = signed(NOW + 300_000, "sig-b");
    expect(decideScreenUrl({ current, next, mountedAt: NOW, now: NOW + 240_000 })).toEqual({
      url: current,
      action: "keep",
    });
  });

  it("swaps when the new URL opens a different screen", () => {
    const current = signed(NOW + 60_000, "sig-a", 49152);
    const next = signed(NOW + 60_000, "sig-b", 49999);
    expect(decideScreenUrl({ current, next, mountedAt: NOW, now: NOW + 1_000 })).toEqual({
      url: next,
      action: "swap",
    });
  });

  it("takes a fresh URL when the iframe is not mounted", () => {
    const current = signed(NOW + 60_000, "sig-a");
    const next = signed(NOW + 120_000, "sig-b");
    expect(decideScreenUrl({ current, next, mountedAt: null, now: NOW + 30_000 })).toEqual({
      url: next,
      action: "swap",
    });
  });

  it("does not report a change when the unmounted iframe already has that URL", () => {
    const current = signed(NOW + 60_000, "sig-a");
    expect(decideScreenUrl({ current, next: current, mountedAt: null, now: NOW })).toEqual({
      url: current,
      action: "keep",
    });
  });

  it("asks for a renewal instead of mounting an iframe with a capability about to expire", () => {
    const current = signed(NOW + 60_000, "sig-a");
    const now = NOW + 60_000 - (SCREEN_URL_RENEW_MARGIN_MS - 1_000);
    expect(decideScreenUrl({ current, next: current, mountedAt: null, now })).toEqual({
      url: null,
      action: "renew",
    });
  });

  it("adopts the first URL it is given", () => {
    const next = signed(NOW + 60_000, "sig-a");
    expect(decideScreenUrl({ current: null, next, mountedAt: null, now: NOW })).toEqual({
      url: next,
      action: "swap",
    });
  });

  it("keeps an unsigned dev URL stable forever", () => {
    const url = "http://127.0.0.1:6080/vnc.html";
    expect(decideScreenUrl({ current: url, next: url, mountedAt: null, now: NOW })).toEqual({
      url,
      action: "keep",
    });
  });

  it("renews when there is nothing usable to show", () => {
    expect(decideScreenUrl({ current: null, next: null, mountedAt: null, now: NOW })).toEqual({
      url: null,
      action: "renew",
    });
  });
});

describe("a screen that dropped", () => {
  const current = signed(NOW + 60_000, "sig-a");

  it("unmounts the dead frame instead of keeping the pinned URL", () => {
    // Keeping the URL is what protects a live session; here the session is gone, so the
    // "mounted => keep" rule must not swallow the reconnect.
    expect(
      decideScreenUrl({
        current,
        next: current,
        mountedAt: NOW,
        now: NOW + 30_000,
        disconnected: true,
      }),
    ).toEqual({ url: null, action: "reconnect" });
  });

  it("still unmounts when the capability is already spent", () => {
    expect(
      decideScreenUrl({
        current,
        next: null,
        mountedAt: NOW,
        now: NOW + 90_000,
        disconnected: true,
      }),
    ).toEqual({ url: null, action: "reconnect" });
  });

  it("mounts the fresh capability on the pass right after the reconnect", () => {
    const next = signed(NOW + 120_000, "sig-b");
    expect(decideScreenUrl({ current: null, next, mountedAt: null, now: NOW + 60_000 })).toEqual({
      url: next,
      action: "swap",
    });
  });
});

describe("screen frame messages", () => {
  const frame = { name: "screen-iframe" };

  it("accepts the sandboxed frame's opaque origin from the window it mounted", () => {
    expect(
      screenFrameEvent(
        { origin: "null", data: { type: SCREEN_MESSAGE.disconnected }, source: frame },
        frame,
        "https://app.example",
      ),
    ).toBe("disconnected");
    expect(
      screenFrameEvent(
        { origin: "https://app.example", data: { type: SCREEN_MESSAGE.connected }, source: frame },
        frame,
        "https://app.example",
      ),
    ).toBe("connected");
  });

  it("ignores anything that did not come from that exact window", () => {
    const other = { name: "someone-else" };
    expect(
      screenFrameEvent(
        { origin: "null", data: { type: SCREEN_MESSAGE.disconnected }, source: other },
        frame,
        "https://app.example",
      ),
    ).toBeNull();
    expect(
      screenFrameEvent(
        { origin: "null", data: { type: SCREEN_MESSAGE.disconnected }, source: frame },
        null,
        "https://app.example",
      ),
    ).toBeNull();
  });

  it("ignores a third-party origin and junk payloads", () => {
    expect(
      screenFrameEvent(
        {
          origin: "https://evil.example",
          data: { type: SCREEN_MESSAGE.disconnected },
          source: frame,
        },
        frame,
        "https://app.example",
      ),
    ).toBeNull();
    expect(
      screenFrameEvent(
        { origin: "null", data: "quibt.screen.disconnected", source: frame },
        frame,
        "x",
      ),
    ).toBeNull();
    expect(screenFrameEvent({ origin: "null", data: null, source: frame }, frame, "x")).toBeNull();
    expect(screenFrameEvent(null, frame, "x")).toBeNull();
  });
});

describe("reconnect backoff", () => {
  it("grows the delay and gives up instead of hammering the proxy", () => {
    const delays: number[] = [];
    let attempt = 0;
    for (let i = 0; i < SCREEN_RECONNECT_LIMIT; i += 1) {
      const plan = planScreenReconnect(attempt);
      expect(plan.retry).toBe(true);
      delays.push(plan.delayMs);
      attempt = plan.nextAttempt;
    }
    expect(delays).toEqual([500, 1_000, 2_000, 4_000]);
    expect(planScreenReconnect(attempt)).toEqual({
      retry: false,
      delayMs: 0,
      nextAttempt: SCREEN_RECONNECT_LIMIT,
    });
  });

  it("caps the delay and treats a reset counter as the first attempt", () => {
    expect(planScreenReconnect(0).delayMs).toBe(SCREEN_RECONNECT_BASE_MS);
    expect(planScreenReconnect(-3).delayMs).toBe(SCREEN_RECONNECT_BASE_MS);
    expect(Math.min(SCREEN_RECONNECT_MAX_MS, SCREEN_RECONNECT_BASE_MS * 2 ** 20)).toBe(
      SCREEN_RECONNECT_MAX_MS,
    );
  });
});

describe("a screen that keeps dropping", () => {
  it("remounts with backoff and then stops, instead of looping on the proxy", () => {
    // The state machine the panel runs: drop -> backoff -> unmount -> fresh capability ->
    // mount, until the budget is spent.
    let attempt = 0;
    let pinned: string | null = signed(NOW + 60_000, "sig-0");
    let mountedAt: number | null = NOW;
    const delays: number[] = [];
    let mounts = 0;

    for (let drop = 0; drop < 20; drop += 1) {
      const plan = planScreenReconnect(attempt);
      if (!plan.retry) break;
      attempt = plan.nextAttempt;
      delays.push(plan.delayMs);

      const dead = decideScreenUrl({
        current: pinned,
        next: pinned,
        mountedAt,
        now: NOW,
        disconnected: true,
      });
      expect(dead).toEqual({ url: null, action: "reconnect" });
      pinned = null;
      mountedAt = null;

      const minted = signed(NOW + 60_000 * (drop + 2), `sig-${drop + 1}`);
      const back = decideScreenUrl({ current: pinned, next: minted, mountedAt, now: NOW });
      expect(back.action).toBe("swap");
      pinned = back.url;
      mountedAt = NOW;
      mounts += 1;
    }

    expect(mounts).toBe(SCREEN_RECONNECT_LIMIT);
    expect(delays).toEqual([500, 1_000, 2_000, 4_000]);
  });
});

describe("embeddableScreenUrl", () => {
  it("refuses a localhost screen on a different port than the page", () => {
    expect(embeddableScreenUrl("http://127.0.0.1:6080/vnc.html", "http://127.0.0.1:5173/app")).toBe(
      null,
    );
    expect(
      embeddableScreenUrl(
        "https://app.example/novnc/abc/1/2.sig/embed.html",
        "https://app.example/",
      ),
    ).toContain("/novnc/");
    expect(
      screenIframeSandbox(
        "https://app.example/novnc/abc/1/2.sig/embed.html",
        "https://app.example/",
      ),
    ).toBe("allow-scripts allow-pointer-lock");
  });
});

describe("shouldFetchScreenUrl", () => {
  const holder = { screenUrl: null, state: "running", controlHolder: "user", open: true };

  it("asks for a URL when the holder's running session has none recorded", () => {
    // The bug this guards: a session reaches `running` with no screen address, the snapshot
    // reports `null`, and the app took that as "there is no screen" — leaving the person who
    // just took control with a placeholder they could not click.
    expect(shouldFetchScreenUrl(holder)).toBe(true);
    expect(shouldFetchScreenUrl({ ...holder, state: "booting" })).toBe(true);
  });

  it("does not ask when the snapshot already carries one", () => {
    expect(shouldFetchScreenUrl({ ...holder, screenUrl: "https://app/novnc/x" })).toBe(false);
  });

  it("does not ask for a screen nobody is looking at, or a lease we do not hold", () => {
    expect(shouldFetchScreenUrl({ ...holder, open: false })).toBe(false);
    expect(shouldFetchScreenUrl({ ...holder, controlHolder: "bot" })).toBe(false);
    expect(shouldFetchScreenUrl({ ...holder, state: "suspended" })).toBe(false);
  });
});
