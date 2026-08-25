import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import asar from "@electron/asar";
import { describe, expect, it } from "vitest";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function packagedAppRoot(outDir: string): string {
  const unpackedApp = readdirSync(outDir).find((entry) => entry.endsWith("-unpacked"));
  if (!unpackedApp) throw new Error("Packaged app directory not found");
  return path.join(outDir, unpackedApp);
}

function electronBinary(appRoot: string): string {
  if (process.platform === "win32") return path.join(appRoot, "Quibt Bot.exe");
  if (process.platform === "darwin")
    return path.join(appRoot, "Quibt Bot.app/Contents/MacOS/Quibt Bot");
  return path.join(appRoot, "quibtbot");
}

describe("native packaging", () => {
  it("configures asarUnpack for cpu-features native addon", () => {
    const pkg = JSON.parse(readFileSync(path.join(desktopRoot, "package.json"), "utf8")) as {
      build?: { asarUnpack?: string[] };
    };
    const unpack = pkg.build?.asarUnpack ?? [];
    expect(unpack.some((entry) => entry.includes("cpu-features"))).toBe(true);
    expect(unpack.some((entry) => entry.includes("ssh2"))).toBe(false);
  });

  it("configures opt-in app and DMG notarization hooks", () => {
    const pkg = JSON.parse(readFileSync(path.join(desktopRoot, "package.json"), "utf8")) as {
      build?: { afterSign?: string; artifactBuildCompleted?: string };
    };
    expect(pkg.build?.afterSign).toBe("scripts/notarize-app.cjs");
    expect(pkg.build?.artifactBuildCompleted).toBe("scripts/notarize-artifact.cjs");

    const notary = require(path.join(desktopRoot, "scripts", "notary.cjs")) as {
      notarizationRequested: (env: Record<string, string>) => boolean;
      notarytoolSubmitArgs: (file: string, env: Record<string, string>) => string[];
    };
    expect(notary.notarizationRequested({})).toBe(false);
    expect(notary.notarizationRequested({ QUIBT_NOTARIZE: "1" })).toBe(true);
    expect(notary.notarytoolSubmitArgs("QuibtBot.dmg", {})).toEqual([
      "notarytool",
      "submit",
      "QuibtBot.dmg",
      "--keychain-profile",
      "quibt-notary",
      "--wait",
    ]);
  });

  it.runIf(process.platform === "linux")(
    "ships ssh2 JS inside app.asar and resolves ssh2/cpu-features in the packaged layout",
    () => {
      execFileSync("pnpm", ["build"], { cwd: desktopRoot, stdio: "pipe" });
      execFileSync("pnpm", ["exec", "electron-builder", "--dir"], {
        cwd: desktopRoot,
        stdio: "pipe",
        env: { ...process.env, CI: "true" },
      });

      const appRoot = packagedAppRoot(path.join(desktopRoot, "out"));
      const asarPath = path.join(appRoot, "resources", "app.asar");
      const unpackedRoot = path.join(appRoot, "resources", "app.asar.unpacked");
      expect(existsSync(asarPath)).toBe(true);

      const asarFiles = asar.listPackage(asarPath);
      expect(
        asarFiles.some((entry) =>
          entry.replace(/\\/g, "/").includes("/node_modules/ssh2/lib/index.js"),
        ),
      ).toBe(true);

      const cpuFeaturesRoot = path.join(unpackedRoot, "node_modules", "cpu-features");
      const cpuFeaturesNode = path.join(cpuFeaturesRoot, "build", "Release", "cpufeatures.node");
      expect(existsSync(cpuFeaturesNode)).toBe(true);

      const electronBin = electronBinary(appRoot);
      expect(existsSync(electronBin)).toBe(true);

      const smoke = `
const path = require("path");
const Module = require("module");
const appRoot = ${JSON.stringify(appRoot)};
const asarNodeModules = path.join(appRoot, "resources", "app.asar", "node_modules");
const unpackedNodeModules = path.join(appRoot, "resources", "app.asar.unpacked", "node_modules");
Module.globalPaths.push(asarNodeModules, unpackedNodeModules);
const ssh2 = require(path.join(asarNodeModules, "ssh2"));
if (!ssh2 || !ssh2.Client) throw new Error("ssh2.Client missing");
let cpu = null;
try {
  cpu = require(path.join(unpackedNodeModules, "cpu-features"));
} catch {}
console.log(cpu ? "cpu+ssh2" : "ssh2");
`;
      const output = execFileSync(electronBin, ["-e", smoke], {
        cwd: appRoot,
        stdio: "pipe",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      }).toString("utf8");
      expect(["cpu+ssh2", "ssh2"]).toContain(output.trim());
    },
    180_000,
  );
});
