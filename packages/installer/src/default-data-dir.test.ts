import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDarwinDataDir } from "./index.js";

describe("resolveDarwinDataDir", () => {
  const home = "/Users/quibt-test";
  const desktop = path.join(home, "Library", "Application Support", "Quibt Bot");
  const legacy = path.join(home, "Library", "Application Support", "Quibt");

  it("uses the desktop userData directory for a new macOS install", () => {
    expect(resolveDarwinDataDir(home, () => false)).toBe(desktop);
  });

  it("uses the desktop installation when both layouts have files", () => {
    expect(resolveDarwinDataDir(home, () => true)).toBe(desktop);
  });

  it("keeps an existing legacy CLI installation when no desktop install exists", () => {
    expect(resolveDarwinDataDir(home, (target) => target === path.join(legacy, "quibt.env"))).toBe(
      legacy,
    );
  });
});
