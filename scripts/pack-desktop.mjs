#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aliasDesktopArtifacts } from "./alias-desktop-artifacts.mjs";
import { packagingEnvironment } from "./packaging-env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2] ?? "all";
const version = JSON.parse(
  readFileSync(path.join(root, "apps/desktop/package.json"), "utf8"),
).version;
const script =
  target === "mac"
    ? "pack:mac"
    : target === "win"
      ? "pack:win"
      : target === "linux"
        ? "pack:linux"
        : "pack";

/**
 * electron-builder signs automatically when these env vars are present (CSC_LINK /
 * CSC_KEY_PASSWORD for macOS codesigning, WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD for Windows)
 * and silently skips signing otherwise. Notarization is a separate step this repo does not
 * run yet (see `mac.notarize: false` in apps/desktop/package.json); it needs Apple
 * credentials too. Checking both here, instead of assuming "packaged" means "signed", is
 * what lets the release workflow annotate unsigned/un-notarized artifacts instead of
 * shipping them silently.
 */
function commandSucceeds(command, args) {
  return spawnSync(command, args, { stdio: "ignore" }).status === 0;
}

function signingStatus(outDir) {
  const macApp = path.join(outDir, "mac-arm64", "Quibt Bot.app");
  const macDmg = path.join(outDir, `QuibtBot-${version}.dmg`);
  // Environment variables only express intent. The release report must describe the
  // bytes that were actually produced, including a maintainer Mac whose Developer ID
  // identity is available directly from Keychain (no CSC_LINK necessary).
  const macSigned =
    process.platform === "darwin" &&
    existsSync(macApp) &&
    commandSucceeds("codesign", ["--verify", "--deep", "--strict", macApp]);
  const macNotarized =
    process.platform === "darwin" &&
    existsSync(macDmg) &&
    commandSucceeds("xcrun", ["stapler", "validate", macDmg]);
  const winSigned = Boolean(process.env.WIN_CSC_LINK && process.env.WIN_CSC_KEY_PASSWORD);
  return {
    mac: { signed: macSigned, notarized: macNotarized },
    win: { signed: winSigned },
  };
}

const packed = spawnSync("pnpm", ["--filter", "@quibt/desktop", script], {
  cwd: root,
  env: packagingEnvironment(),
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (packed.status) process.exit(packed.status);

const outDir = path.join(root, "apps/desktop/out");
const aliases = aliasDesktopArtifacts(outDir, version, target);
for (const name of aliases) {
  console.log(`Stable artifact: apps/desktop/out/${name}`);
}

const status = signingStatus(outDir);
writeFileSync(
  path.join(outDir, "signing-status.json"),
  `${JSON.stringify({ target, version, ...status }, null, 2)}\n`,
);

console.log(`Desktop pack finished (${target}).`);
if (target === "mac" || target === "all") {
  console.log(
    status.mac.signed
      ? "macOS signing: packaged app verified with codesign."
      : "macOS signing: packaged app did not pass codesign verification.",
  );
  console.log(
    status.mac.notarized
      ? "Notarization: stapled Apple ticket verified on the DMG."
      : "Notarization: no stapled Apple ticket verified on the DMG.",
  );
}
if (target === "win" || target === "all") {
  console.log(
    status.win.signed
      ? "Windows signing: ran (WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD set)."
      : "Windows signing: not run. WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD are unset — this " +
          "artifact is unsigned.",
  );
}
