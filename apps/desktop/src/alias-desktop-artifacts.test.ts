import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { aliasDesktopArtifacts } from "../../../scripts/alias-desktop-artifacts.mjs";

describe("aliasDesktopArtifacts", () => {
  it("writes the stable Mac, Windows, and Linux names the landing downloads", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "quibt-pack-"));
    writeFileSync(path.join(dir, "QuibtBot-0.1.0.dmg"), "mac");
    writeFileSync(path.join(dir, "QuibtBot-0.1.0-setup.exe"), "win");
    writeFileSync(path.join(dir, "QuibtBot-0.1.0.AppImage"), "linux");

    expect(aliasDesktopArtifacts(dir, "0.1.0", "all")).toEqual([
      "QuibtBot.dmg",
      "QuibtBot-setup.exe",
      "QuibtBot.AppImage",
    ]);
    expect(readFileSync(path.join(dir, "QuibtBot.dmg"), "utf8")).toBe("mac");
    expect(readFileSync(path.join(dir, "QuibtBot-setup.exe"), "utf8")).toBe("win");
    expect(readFileSync(path.join(dir, "QuibtBot.AppImage"), "utf8")).toBe("linux");
  });

  it("aliases a spaced electron-builder AppImage name", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "quibt-pack-"));
    writeFileSync(path.join(dir, "Quibt Bot-0.1.0.AppImage"), "linux");
    expect(aliasDesktopArtifacts(dir, "0.1.0", "linux")).toEqual(["QuibtBot.AppImage"]);
    expect(readFileSync(path.join(dir, "QuibtBot.AppImage"), "utf8")).toBe("linux");
  });
});
