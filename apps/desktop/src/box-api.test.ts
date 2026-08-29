import { describe, expect, it } from "vitest";
import {
  BOX_TRIAL_SERVER_TTL_SECONDS,
  type BoxRecord,
  createServerBoxRequest,
  isServerBoxRecord,
} from "./box-api.js";

describe("box-api schemas", () => {
  it("validates no-env server boxes with null or omitted environment", () => {
    const valid: BoxRecord = {
      id: "bx_23456789",
      name: "Quibt Bot server",
      state: "ready",
      environment: null,
    };
    expect(isServerBoxRecord(valid)).toBe(true);
    expect(isServerBoxRecord({ ...valid, environment: "base" })).toBe(false);
    expect(isServerBoxRecord({ ...valid, environment: undefined })).toBe(true);
  });

  it("creates boxes with noEnv only and without environment null", () => {
    expect(createServerBoxRequest()).toEqual({ ttlSeconds: null, noEnv: true });
    expect(createServerBoxRequest(BOX_TRIAL_SERVER_TTL_SECONDS)).toEqual({
      ttlSeconds: 7_200,
      noEnv: true,
    });
    expect(createServerBoxRequest()).not.toHaveProperty("environment");
  });
});
