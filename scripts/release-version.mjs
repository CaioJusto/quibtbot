#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The three images the release workflow builds and pushes to GHCR. Names only
 * (no tag) — `releaseManifest` appends `:<release>` so every image shares one
 * version with no second, independent tag.
 */
export const RELEASE_IMAGE_NAMES = ["quibt-computer", "quibt-supervisor", "quibt-stack"];

/**
 * Stable, unversioned artifact names GitHub Releases/the landing page link to.
 * electron-builder writes versioned files; `alias-desktop-artifacts.mjs` copies
 * these aliases. Keep in sync — this is the one place both sides read from.
 */
export const DESKTOP_ARTIFACT_NAMES = Object.freeze({
  mac: "QuibtBot.dmg",
  windows: "QuibtBot-setup.exe",
  linux: "QuibtBot.AppImage",
});

/**
 * Standalone `quibtbot` CLI binaries built with Node's single-executable
 * application feature. Linux names are load-bearing: `apps/desktop/src/release-manifest.ts`
 * and `release-artifacts.ts` already embed a SHA-256-verified bootstrap for
 * exactly `quibtbot-linux-x64` / `quibtbot-linux-arm64`.
 */
export const CLI_BINARY_TARGETS = Object.freeze([
  Object.freeze({ platform: "linux", arch: "x64", name: "quibtbot-linux-x64" }),
  Object.freeze({ platform: "linux", arch: "arm64", name: "quibtbot-linux-arm64" }),
  Object.freeze({ platform: "darwin", arch: "arm64", name: "quibtbot-darwin-arm64" }),
  Object.freeze({ platform: "win32", arch: "x64", name: "quibtbot-win32-x64.exe" }),
]);

const STRICT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * A strict, clean semver: no surrounding whitespace, no newlines, and no
 * "dirty" marker (the suffix `git describe --dirty` appends to an
 * uncommitted checkout). Release input must be exactly what a `vX.Y.Z` git
 * tag would produce.
 */
export function parseReleaseVersion(input) {
  if (typeof input !== "string") return null;
  if (input.length === 0) return null;
  if (input.includes("\n") || input.includes("\r")) return null;
  const trimmed = input.trim();
  if (trimmed !== input) return null;
  if (/dirty/i.test(trimmed)) return null;
  if (!STRICT_SEMVER.test(trimmed)) return null;
  return trimmed;
}

export function releaseImageName(name, release) {
  return `ghcr.io/quibt/${name}:${release}`;
}

/**
 * The single manifest every image build, packaging, and CLI-binary job
 * reads from. One version in, one consistent set of image tags and artifact
 * names out — no job is allowed to invent its own second version.
 */
export function releaseManifest(version) {
  const release = parseReleaseVersion(version);
  if (!release) {
    throw new Error(
      `Release version ${JSON.stringify(version)} is not a clean semver. Dirty checkouts ` +
        '(e.g. a "-dirty" suffix), "v" prefixes, and non-semver tags are rejected.',
    );
  }

  const images = {};
  for (const name of RELEASE_IMAGE_NAMES) {
    images[name] = releaseImageName(name, release);
  }

  return {
    schemaVersion: 1,
    release,
    images,
    desktopArtifacts: { ...DESKTOP_ARTIFACT_NAMES },
    cliBinaries: CLI_BINARY_TARGETS.map((target) => ({ ...target })),
  };
}

function isMainModule() {
  const entry = process.argv[1];
  return Boolean(entry && path.resolve(entry) === fileURLToPath(import.meta.url));
}

function main() {
  const version = process.argv[2];
  if (!version) {
    console.error("Usage: node scripts/release-version.mjs <version>");
    process.exit(2);
  }
  try {
    const manifest = releaseManifest(version);
    console.log(JSON.stringify(manifest, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

if (isMainModule()) {
  main();
}
