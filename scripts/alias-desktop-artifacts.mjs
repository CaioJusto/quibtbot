import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Landing / GitHub Releases use stable names (QuibtBot.dmg, QuibtBot-setup.exe,
 * QuibtBot.AppImage). electron-builder writes versioned files; this copies the
 * aliases so Mac, Windows, and Linux share the same publish path.
 */
export function aliasDesktopArtifacts(outDir, version, target = "all") {
  mkdirSync(outDir, { recursive: true });
  const aliases = [];
  const want = (kind) => target === "all" || target === kind;

  if (want("mac")) {
    const dmg = path.join(outDir, `QuibtBot-${version}.dmg`);
    if (existsSync(dmg)) {
      copyFileSync(dmg, path.join(outDir, "QuibtBot.dmg"));
      aliases.push("QuibtBot.dmg");
    }
  }

  if (want("win")) {
    const exe = path.join(outDir, `QuibtBot-${version}-setup.exe`);
    if (existsSync(exe)) {
      copyFileSync(exe, path.join(outDir, "QuibtBot-setup.exe"));
      aliases.push("QuibtBot-setup.exe");
    }
  }

  if (want("linux") || want("all")) {
    const exact = path.join(outDir, `QuibtBot-${version}.AppImage`);
    const alias = path.join(outDir, "QuibtBot.AppImage");
    if (existsSync(exact)) {
      copyFileSync(exact, alias);
      aliases.push("QuibtBot.AppImage");
    } else if (existsSync(outDir)) {
      const found = readdirSync(outDir).find((name) => name.endsWith(".AppImage"));
      if (found) {
        copyFileSync(path.join(outDir, found), alias);
        aliases.push("QuibtBot.AppImage");
      }
    }
  }

  return aliases;
}
