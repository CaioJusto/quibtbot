import { describe, expect, it } from "vitest";
import {
  desktopComputerSurface,
  normalizeTypedBrowserUrl,
  takeoverRequested,
} from "./bot-browser.js";

describe("desktop computer surface", () => {
  it("offers the embedded browser only inside the desktop app", () => {
    expect(desktopComputerSurface(undefined)).toBe("novnc");
    expect(desktopComputerSurface({ platform: "darwin" } as never)).toBe("embedded");
  });

  it("turns a typed address into https without opening the host Chrome", () => {
    expect(normalizeTypedBrowserUrl("banco.example/login")).toBe("https://banco.example/login");
    expect(normalizeTypedBrowserUrl("https://ok.example")).toBe("https://ok.example/");
    expect(normalizeTypedBrowserUrl("file:///tmp")).toBe(null);
    expect(normalizeTypedBrowserUrl("")).toBe(null);
  });

  it("treats waiting_takeover on the run or the computer session as a handoff", () => {
    expect(takeoverRequested({ runStatus: "waiting_takeover" })).toBe(true);
    expect(takeoverRequested({ waitingTakeover: true })).toBe(true);
    expect(takeoverRequested({ runStatus: "running", waitingTakeover: false })).toBe(false);
  });
});
