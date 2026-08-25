import { describe, expect, it } from "vitest";
import { shouldLoadOfflinePage, windowRevealActions } from "./window-behavior.js";

describe("windowRevealActions", () => {
  it("restores a minimized window before showing and focusing it", () => {
    expect(windowRevealActions({ minimized: true, visible: true, focused: false })).toEqual([
      "restore",
      "focus",
    ]);
    expect(windowRevealActions({ minimized: true, visible: false, focused: false })).toEqual([
      "restore",
      "show",
      "focus",
    ]);
  });

  it("still focuses a visible window so a second launch comes to the front", () => {
    expect(windowRevealActions({ minimized: false, visible: true, focused: false })).toEqual([
      "focus",
    ]);
    expect(windowRevealActions({ minimized: false, visible: true, focused: true })).toEqual([]);
  });
});

describe("shouldLoadOfflinePage", () => {
  const base = {
    isMainFrame: true,
    url: "https://app.example.com/",
    errorCode: -106,
    requestedUrl: "https://app.example.com/",
    offlineAvailable: true,
    destroyed: false,
  };

  it("replaces the page only when the failed load is still the one we asked for", () => {
    expect(shouldLoadOfflinePage(base)).toBe(true);
    expect(
      shouldLoadOfflinePage({ ...base, requestedUrl: "https://app.example.com/billing" }),
    ).toBe(false);
    expect(shouldLoadOfflinePage({ ...base, requestedUrl: null })).toBe(true);
  });

  it("shows the offline page when only Chromium's canonical trailing slash differs", () => {
    // `QUIBT_WEB_URL` defaults to "http://127.0.0.1:5173"; the failure comes back with the
    // slash Chromium adds, which is exactly the first launch against a stack that is down.
    expect(
      shouldLoadOfflinePage({
        ...base,
        url: "http://127.0.0.1:5173/",
        requestedUrl: "http://127.0.0.1:5173",
      }),
    ).toBe(true);
    expect(
      shouldLoadOfflinePage({
        ...base,
        url: "https://app.example.com/",
        requestedUrl: "https://app.example.com",
      }),
    ).toBe(true);
  });

  it("still ignores a failure for a page we no longer asked for", () => {
    expect(
      shouldLoadOfflinePage({
        ...base,
        url: "https://app.example.com/billing",
        requestedUrl: "https://app.example.com/",
      }),
    ).toBe(false);
    expect(
      shouldLoadOfflinePage({
        ...base,
        url: "https://other.example.com/",
        requestedUrl: "https://app.example.com/",
      }),
    ).toBe(false);
  });

  it("ignores subframes, aborted loads, file pages, and closed windows", () => {
    expect(shouldLoadOfflinePage({ ...base, isMainFrame: false })).toBe(false);
    expect(shouldLoadOfflinePage({ ...base, errorCode: -3 })).toBe(false);
    expect(
      shouldLoadOfflinePage({ ...base, url: "file:///offline.html", requestedUrl: null }),
    ).toBe(false);
    expect(shouldLoadOfflinePage({ ...base, destroyed: true })).toBe(false);
    expect(shouldLoadOfflinePage({ ...base, offlineAvailable: false })).toBe(false);
  });
});
