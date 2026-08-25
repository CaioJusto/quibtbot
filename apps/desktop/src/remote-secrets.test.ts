import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
}));

import { loadBoxApiKey, trySaveBoxApiKey } from "./remote-secrets.js";

describe("remote-secrets trySave", () => {
  it("persists encrypted credentials with secure file permissions", () => {
    const userData = mkdtempSync(path.join(tmpdir(), "quibt-secrets-ok-"));
    const result = trySaveBoxApiKey(userData, "box_live_secret");
    expect(result.ok).toBe(true);
    const storedPath = path.join(userData, "secure", "box-api-key.json");
    expect(statSync(storedPath).mode & 0o777).toBe(0o600);
    expect(loadBoxApiKey(userData)).toBe("box_live_secret");
  });
});
