import { describe, expect, it } from "vitest";
import { redactInstallerText } from "./redact.js";

describe("installer redaction", () => {
  it("redacts exact secrets and credential-shaped assignments", () => {
    expect(
      redactInstallerText("ssh password hunter2\nBETTER_AUTH_SECRET=abc", ["hunter2", "abc"]),
    ).toBe("ssh password [REDACTED]\nBETTER_AUTH_SECRET=[REDACTED]");
  });

  it("redacts any sensitive assignment even when the value is unknown", () => {
    expect(redactInstallerText("CUSTOM_API_KEY=super-secret-value\nSAFE=value")).toBe(
      "CUSTOM_API_KEY=[REDACTED]\nSAFE=value",
    );
  });
});
