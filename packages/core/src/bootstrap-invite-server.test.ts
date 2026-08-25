import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isAuthorizedBootstrapSecret, timingSafeEqualDigest } from "./bootstrap-invite-server.js";

describe("timingSafeEqualDigest", () => {
  it("compares SHA-256 digests without short-circuiting on length", () => {
    const left = createHash("sha256").update("abc", "utf8").digest("hex");
    const right = createHash("sha256").update("abc", "utf8").digest("hex");
    const wrong = createHash("sha256").update("xyz", "utf8").digest("hex");
    expect(timingSafeEqualDigest(left, right)).toBe(true);
    expect(timingSafeEqualDigest(left, wrong)).toBe(false);
    expect(timingSafeEqualDigest(left, "short")).toBe(false);
  });
});

describe("isAuthorizedBootstrapSecret", () => {
  it("accepts matching secrets and rejects mismatches", () => {
    const secret = "bootstrap-secret-32chars-minimum";
    expect(isAuthorizedBootstrapSecret(secret, secret)).toBe(true);
    expect(isAuthorizedBootstrapSecret("other-secret-32chars-minimum", secret)).toBe(false);
  });
});
