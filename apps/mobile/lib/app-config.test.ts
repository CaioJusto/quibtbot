import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mobileRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const appConfigSource = readFileSync(path.join(mobileRoot, "app.json"), "utf8");
const easConfigSource = readFileSync(path.join(mobileRoot, "eas.json"), "utf8");
const config = JSON.parse(appConfigSource) as {
  expo: {
    android?: { package?: string; userInterfaceStyle?: string; versionCode?: number };
    ios?: {
      appleTeamId?: string;
      buildNumber?: string;
      infoPlist?: Record<string, unknown>;
      userInterfaceStyle?: string;
    };
    plugins?: Array<string | [string, Record<string, unknown>]>;
    runtimeVersion?: { policy?: string };
    userInterfaceStyle?: string;
    version?: string;
  };
};
const easConfig = JSON.parse(easConfigSource) as {
  submit?: { production?: { ios?: { ascAppId?: string } } };
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

  it("fails closed unless iOS is built for the Caio Justo Apple team", () => {
    expect(config.expo.ios?.appleTeamId).toBe("9Q372SFRM8");
    expect(appConfigSource).not.toContain("PFCLC953QY");
    expect(easConfigSource).not.toContain("6806465867");
    expect(easConfig.submit?.production?.ios?.ascAppId).toBeUndefined();
  });

  it("isolates OTA updates whenever the native dependency fingerprint changes", () => {
    expect(config.expo.runtimeVersion).toEqual({ policy: "fingerprint" });
    expect(config.expo.version).toBe("0.2.19");
    expect(config.expo.ios?.buildNumber).toBe("18");
    expect(config.expo.android?.versionCode).toBe(18);
  });

  it("enables the complete iOS dark palette without exposing a partial Android theme", () => {
    expect(config.expo.userInterfaceStyle).toBe("automatic");
    expect(config.expo.ios?.userInterfaceStyle).toBe("automatic");
    expect(config.expo.android?.userInterfaceStyle).toBe("light");
    const splash = config.expo.plugins?.find(
      (plugin): plugin is [string, Record<string, unknown>] =>
        Array.isArray(plugin) && plugin[0] === "expo-splash-screen",
    );
    expect(splash?.[1]).toMatchObject({ dark: { backgroundColor: "#161618" } });
  });
});
