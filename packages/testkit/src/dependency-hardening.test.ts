import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

function metroPackage(): { dependencies?: Record<string, string> } {
  // Resolve through the mobile app's installed dependency graph. The pnpm store can retain
  // unused Metro versions after an upgrade, and scanning it would test stale cache instead.
  const mobileRequire = createRequire(path.resolve(process.cwd(), "apps/mobile/package.json"));
  const metroConfigPackage = mobileRequire.resolve("@react-native/metro-config/package.json");
  const metroRequire = createRequire(metroConfigPackage);
  return JSON.parse(readFileSync(metroRequire.resolve("metro/package.json"), "utf8"));
}

describe("Metro dependency hardening", () => {
  it("does not reintroduce the vulnerable image-size parser", () => {
    expect(metroPackage().dependencies).not.toHaveProperty("image-size");
  });
});
