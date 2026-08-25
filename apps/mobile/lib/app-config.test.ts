import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const config = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../app.json"), "utf8"),
) as {
  expo: {
    android?: { package?: string };
    ios?: { infoPlist?: Record<string, unknown> };
    plugins?: Array<string | [string, Record<string, unknown>]>;
  };
};

describe("mobile native app config", () => {
  it("has a stable Android identity and permits the WireGuard-protected Tailscale HTTP path", () => {
    expect(config.expo.android?.package).toBe("app.quibt.bot");
    // JavaScript rejects ordinary LAN/public HTTP; cleartext remains enabled only because
    // Tailscale IP traffic is already authenticated and encrypted by WireGuard.
    expect(config.expo.plugins).toContainEqual([
      "expo-build-properties",
      { android: { usesCleartextTraffic: true } },
    ]);
  });

  it("explains the iOS local-network permission used by QR pairing", () => {
    expect(config.expo.ios?.infoPlist?.NSLocalNetworkUsageDescription).toBe(
      "O Quibt Bot usa a rede local para conectar este iPhone ao computador dos seus bots.",
    );
  });
});
