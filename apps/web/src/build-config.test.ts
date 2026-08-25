import { describe, expect, it } from "vitest";
import { screenProxySecretFor } from "./build-config.js";

describe("screenProxySecretFor", () => {
  it("allows a static build without runtime secrets", () => {
    expect(screenProxySecretFor("build", { NODE_ENV: "production" })).toMatch(/build/);
  });

  it("keeps production dev and preview servers fail-closed", () => {
    expect(() => screenProxySecretFor("serve", { NODE_ENV: "production" })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });
});
