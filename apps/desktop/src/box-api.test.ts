import { describe, expect, it } from "vitest";
import { type BoxRecord, createServerBoxRequest, isServerBoxRecord } from "./box-api.js";

describe("box-api schemas", () => {
  it("validates server boxes by environment === null and dedicated name", () => {
    const valid: BoxRecord = {
      id: "bx_23456789",
      name: "Quibt Bot server",
      state: "ready",
      environment: null,
    };
    expect(isServerBoxRecord(valid)).toBe(true);
    expect(isServerBoxRecord({ ...valid, environment: "base" })).toBe(false);
    expect(isServerBoxRecord({ ...valid, environment: undefined })).toBe(false);
  });

  it("creates boxes with noEnv only and without environment null", () => {
    expect(createServerBoxRequest()).toEqual({ ttlSeconds: null, noEnv: true });
    expect(createServerBoxRequest()).not.toHaveProperty("environment");
  });
});
