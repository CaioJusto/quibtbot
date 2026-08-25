import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allQuibtImages, INSTALL_RELEASE } from "../packages/installer/src/compose.js";
import {
  CLI_BINARY_TARGETS,
  DESKTOP_ARTIFACT_NAMES,
  parseReleaseVersion,
  RELEASE_IMAGE_NAMES,
  releaseManifest,
} from "./release-version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(root, "scripts", "release-version.mjs");

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

describe("releaseManifest", () => {
  it("emits the exact ghcr image names and tags for the requested version", () => {
    const manifest = releaseManifest("0.2.0");
    expect(manifest.release).toBe("0.2.0");
    expect(manifest.images).toEqual({
      "quibt-computer": "ghcr.io/quibt/quibt-computer:0.2.0",
      "quibt-supervisor": "ghcr.io/quibt/quibt-supervisor:0.2.0",
      "quibt-stack": "ghcr.io/quibt/quibt-stack:0.2.0",
    });
    expect(Object.keys(manifest.images)).toEqual(RELEASE_IMAGE_NAMES);
  });

  it("keeps the exact stable desktop artifact names", () => {
    const manifest = releaseManifest("0.2.0");
    expect(manifest.desktopArtifacts).toEqual({
      mac: "QuibtBot.dmg",
      windows: "QuibtBot-setup.exe",
      linux: "QuibtBot.AppImage",
    });
    expect(manifest.desktopArtifacts).toEqual(DESKTOP_ARTIFACT_NAMES);
  });

  it("lists platform-specific quibtbot CLI binary names, matching the existing Linux artifact protocol", () => {
    const manifest = releaseManifest("0.2.0");
    const names = manifest.cliBinaries.map((target) => target.name);
    // These two names are load-bearing: apps/desktop/src/release-manifest.ts and
    // release-artifacts.ts already ship a SHA-256-verified bootstrap for exactly these.
    expect(names).toContain("quibtbot-linux-x64");
    expect(names).toContain("quibtbot-linux-arm64");
    expect(names).toEqual(CLI_BINARY_TARGETS.map((target) => target.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it("rejects dirty checkouts and non-strict-semver release input", () => {
    for (const bad of [
      "0.2.0-dirty",
      "0.2.0+dirty",
      "v0.2.0",
      "0.2.0\n",
      " 0.2.0",
      "not-a-version",
      "",
      "0.2",
    ]) {
      expect(() => releaseManifest(bad), `expected "${bad}" to be rejected`).toThrow();
      expect(parseReleaseVersion(bad)).toBeNull();
    }
  });

  it("accepts a clean strict-semver release", () => {
    expect(parseReleaseVersion("0.2.0")).toBe("0.2.0");
    expect(() => releaseManifest("0.2.0")).not.toThrow();
  });

  it("produces one consistent JSON manifest from the CLI entrypoint", () => {
    const stdout = execFileSync(process.execPath, [scriptPath, "0.2.0"], {
      cwd: root,
      encoding: "utf8",
    });
    const manifest = JSON.parse(stdout);
    expect(manifest).toEqual(releaseManifest("0.2.0"));
  });

  it("exits non-zero from the CLI entrypoint on dirty/invalid input", () => {
    expect(() =>
      execFileSync(process.execPath, [scriptPath, "0.2.0-dirty"], { cwd: root, encoding: "utf8" }),
    ).toThrow();
  });
});

describe("one version, every consumer", () => {
  it("resolves the installer, desktop, CLI, site and image tags from the same release version", () => {
    const desktopPkg = readJson("apps/desktop/package.json") as { version: string };
    const sitePath = path.join(root, "apps/www/src/site.ts");
    const siteSource = readFileSync(sitePath, "utf8");
    const desktopVersionMatch = /export const DESKTOP_VERSION = ([A-Za-z0-9_]+);/.exec(siteSource);

    // The site must not hard-code a second literal version string; it must import/derive one.
    expect(
      desktopVersionMatch,
      "site.ts must derive DESKTOP_VERSION from a constant, not a literal",
    ).not.toBeNull();
    expect(siteSource).not.toMatch(/DESKTOP_VERSION\s*=\s*"0\.1\.0"/);
    expect(siteSource).toMatch(/INSTALL_RELEASE/);

    const release = INSTALL_RELEASE;
    const rootPkg = readJson("package.json") as { version: string };
    const cliPkg = readJson("apps/cli/package.json") as { version: string };
    expect(rootPkg.version).toBe(release);
    expect(cliPkg.version).toBe(release);
    expect(desktopPkg.version).toBe(release);

    const manifest = releaseManifest(release);
    const images = allQuibtImages(
      {
        services: {
          computer: { image: manifest.images["quibt-computer"] },
          supervisor: {
            image: manifest.images["quibt-supervisor"],
            environment: { QUIBT_COMPUTER_IMAGE: manifest.images["quibt-computer"] },
          },
          api: { image: manifest.images["quibt-stack"] },
        },
      },
      release,
    );
    expect(images.sort()).toEqual(Object.values(manifest.images).sort());
  });

  it("keeps the same version wired through the installer, desktop packaging and CLI --version output", async () => {
    const { runCliAsync } = await import("../apps/cli/src/main.js");
    const logs: string[] = [];
    const exitCode = await runCliAsync(["--version"], { log: (msg: string) => logs.push(msg) });
    expect(exitCode).toBe(0);
    expect(logs).toEqual([INSTALL_RELEASE]);

    const rootPkg = readJson("package.json") as { version: string };
    const cliPkg = readJson("apps/cli/package.json") as { version: string };
    const desktopPkg = readJson("apps/desktop/package.json") as {
      version: string;
      build?: { extraMetadata?: { quibtStackVersion?: string } };
    };
    expect(rootPkg.version).toBe(INSTALL_RELEASE);
    expect(cliPkg.version).toBe(INSTALL_RELEASE);
    expect(desktopPkg.version).toBe(INSTALL_RELEASE);
    expect(desktopPkg.build?.extraMetadata?.quibtStackVersion).toBe(INSTALL_RELEASE);
  });
});
