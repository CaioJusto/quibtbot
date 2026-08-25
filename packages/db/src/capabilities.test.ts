import { CAPABILITY_LIMITS } from "@quibt/contracts";
import { describe, expect, it } from "vitest";
import {
  CapabilityInstallError,
  capabilityDigest,
  validateCapabilityInstall,
} from "./capabilities.js";

describe("capability install bounds", () => {
  it("uses a stable recursive digest", () => {
    expect(capabilityDigest("source", { nested: { a: 1, b: 2 } })).toBe(
      capabilityDigest("source", { nested: { b: 2, a: 1 } }),
    );
  });

  it("rejects oversized names and configs before opening a transaction", () => {
    expect(() =>
      validateCapabilityInstall({
        kind: "skill",
        name: "x".repeat(CAPABILITY_LIMITS.nameChars + 1),
        source: "user",
        config: {},
      }),
    ).toThrow(CapabilityInstallError);
    expect(() =>
      validateCapabilityInstall({
        kind: "skill",
        name: "bounded",
        source: "user",
        config: { instructions: "x".repeat(CAPABILITY_LIMITS.configBytes + 1) },
      }),
    ).toThrow(/too_large/);
  });
});
