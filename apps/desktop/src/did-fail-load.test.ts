import { describe, expect, it } from "vitest";
import { isMainFrameLoadFailure, parseDidFailLoad } from "./did-fail-load.js";

describe("did-fail-load parsing", () => {
  it("uses the Electron argument order with exact main-frame flag", () => {
    const event = parseDidFailLoad(
      { sender: "frame" },
      -105,
      "ERR_NAME_NOT_RESOLVED",
      "https://remote.example.com/",
      true,
    );
    expect(event.errorCode).toBe(-105);
    expect(event.validatedURL).toBe("https://remote.example.com/");
    expect(event.isMainFrame).toBe(true);
    expect(isMainFrameLoadFailure(event)).toBe(true);
  });

  it("ignores subframe failures", () => {
    const event = parseDidFailLoad(
      { sender: "frame" },
      -3,
      "ERR_ABORTED",
      "https://remote.example.com/ads",
      false,
    );
    expect(isMainFrameLoadFailure(event)).toBe(false);
  });
});
