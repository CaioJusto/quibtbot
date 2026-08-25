import { describe, expect, it } from "vitest";
import { nextInstallStep } from "./state.js";

describe("installer state", () => {
  it("resumes at the first incomplete step", () => {
    expect(
      nextInstallStep({
        version: 1,
        release: "0.2.0",
        completed: ["requirements", "environment"],
        updatedAt: "2026-08-17T00:00:00.000Z",
      }),
    ).toBe("images");
  });
});
