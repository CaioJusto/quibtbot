import { describe, expect, it } from "vitest";
import { isTransientNetworkFailure, isTransientNetworkMessage } from "./network-errors.js";

describe("transient network errors", () => {
  it("recognizes the native iOS error emitted after returning from device-code login", () => {
    const message =
      "fetch failed: UnexpectedException: The network connection was lost. (at ExpoModulesCore/Promise.swift:56)";
    expect(isTransientNetworkMessage(message)).toBe(true);
    expect(isTransientNetworkFailure(new Error(message))).toBe(true);
  });

  it("recognizes the other runtimes without swallowing provider errors", () => {
    expect(isTransientNetworkMessage("Network request failed")).toBe(true);
    expect(isTransientNetworkMessage("TypeError: Failed to fetch")).toBe(true);
    expect(isTransientNetworkMessage("HTTP 503")).toBe(true);
    expect(isTransientNetworkMessage("Invalid device code")).toBe(false);
    expect(isTransientNetworkFailure("fetch failed")).toBe(false);
  });
});
