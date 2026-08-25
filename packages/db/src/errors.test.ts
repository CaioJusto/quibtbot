import { describe, expect, it } from "vitest";
import { isRunNonceConflict } from "./errors.js";

describe("isRunNonceConflict", () => {
  it("recognizes a Prisma unique clash on clientNonce", () => {
    expect(
      isRunNonceConflict({
        code: "P2002",
        meta: { modelName: "Run", target: ["workspaceId", "clientNonce"] },
      }),
    ).toBe(true);
  });

  it("ignores other unique clashes and plain errors", () => {
    expect(isRunNonceConflict({ code: "P2002", meta: { target: ["email"] } })).toBe(false);
    expect(isRunNonceConflict(new Error("boom"))).toBe(false);
    expect(isRunNonceConflict(null)).toBe(false);
  });
});
