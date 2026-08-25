import { ORPCError } from "@orpc/server";
import { IsolationError } from "@quibt/db";
import { describe, expect, it } from "vitest";
import { isolationToOrpc, rethrowIsolation } from "./isolation.js";

describe("isolationToOrpc", () => {
  it("maps a missing row to NOT_FOUND instead of a 500", () => {
    const mapped = isolationToOrpc(new IsolationError());
    expect(mapped).toBeInstanceOf(ORPCError);
    expect(mapped.code).toBe("NOT_FOUND");
  });

  it("maps a busy bot to CONFLICT", () => {
    expect(isolationToOrpc(new IsolationError("Bot is busy")).code).toBe("CONFLICT");
  });

  it("maps a validation isolation to BAD_REQUEST", () => {
    expect(isolationToOrpc(new IsolationError("Keep at least one task")).code).toBe("BAD_REQUEST");
    expect(isolationToOrpc(new IsolationError("A bot cannot message itself")).code).toBe(
      "BAD_REQUEST",
    );
  });
});

describe("rethrowIsolation", () => {
  it("leaves unrelated errors alone", () => {
    expect(() => rethrowIsolation(new Error("connection lost"))).toThrow("connection lost");
  });
});
