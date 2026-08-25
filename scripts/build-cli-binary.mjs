#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { CLI_BINARY_TARGETS, releaseManifest } from "./release-version.mjs";

/**
 * Builds one standalone `quibtbot` binary for the runner this script is
 * invoked on, using Node's single-executable application (SEA) feature.
 * Cross-platform binaries come from running this once per OS in the release
 * workflow's build matrix (Task 4) — this script only ever builds the binary
 * for `process.platform`/`process.arch`.
 *
 * The embedded JS blob is a bundle of the real `quibtbot` CLI
 * (`apps/cli/src/main.ts`), so `install`/`status`/`doctor`/`pair`/`update`
 * behave exactly as the npm-distributed CLI — this does not invent a second
 * install protocol. The manifest and release version are embedded as SEA
 * assets purely for provenance (`quibtbot --version` still reports
 * `INSTALL_RELEASE` from `@quibt/installer`, the same source `releaseManifest`
 * reads from).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
// The fixed fuse string Node's SEA loader searches for; flipping its last
// character to "1" (which postject does) marks the binary as SEA-enabled.
// https://nodejs.org/api/single-executable-applications.html
const SEA_SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function readArg(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

export function currentCliBinaryTarget(platform = process.platform, arch = process.arch) {
  const target = CLI_BINARY_TARGETS.find(
    (candidate) => candidate.platform === platform && candidate.arch === arch,
  );
  if (!target) {
    const supported = CLI_BINARY_TARGETS.map((t) => `${t.platform}/${t.arch}`).join(", ");
    throw new Error(
      `No quibtbot CLI binary target for ${platform}/${arch}. Supported runners: ${supported}.`,
    );
  }
  return target;
}

function bundleCliEntry(entryFile, outFile) {
  esbuild.buildSync({
    entryPoints: [entryFile],
    outfile: outFile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    logLevel: "warning",
  });
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function buildCliBinary(release, options = {}) {
  const manifest = releaseManifest(release); // throws on dirty/invalid input
  const target = currentCliBinaryTarget();
  const outDir = path.resolve(options.outDir ?? path.join(root, "dist", "cli-binaries"));
  const composeFile = path.resolve(
    options.composeFile ?? path.join(root, "infra/compose/docker-compose.desktop.yml"),
  );
  mkdirSync(outDir, { recursive: true });

  const workDir = mkdtempSync(path.join(os.tmpdir(), "quibtbot-sea-"));
  try {
    // Calls the exported async entrypoint directly instead of relying on
    // main.ts's own `isMainModule()` auto-run check, which compares
    // `import.meta.url` to `process.argv[1]` — a check that cannot resolve
    // correctly once the script is embedded inside a SEA binary.
    const entryFile = path.join(workDir, "entry.mjs");
    writeFileSync(
      entryFile,
      [
        `import { runCliAsync } from ${JSON.stringify(path.join(root, "apps/cli/src/main.ts"))};`,
        "runCliAsync(process.argv.slice(2)).then((code) => { process.exitCode = code; });",
        "",
      ].join("\n"),
    );

    const bundleFile = path.join(workDir, "bundle.cjs");
    bundleCliEntry(entryFile, bundleFile);

    const manifestFile = path.join(workDir, "release-manifest.json");
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    const releaseFile = path.join(workDir, "release-version.txt");
    writeFileSync(releaseFile, manifest.release);

    const blobPath = path.join(workDir, "sea-prep.blob");
    const seaConfigPath = path.join(workDir, "sea-config.json");
    writeFileSync(
      seaConfigPath,
      JSON.stringify(
        {
          main: bundleFile,
          output: blobPath,
          disableExperimentalSEAWarning: true,
          useSnapshot: false,
          useCodeCache: false,
          assets: {
            "release-manifest.json": manifestFile,
            "release-version.txt": releaseFile,
            // O binário anda sozinho numa VPS (curl + chmod + install): o manifesto do
            // compose vai dentro dele e sai para a pasta de dados na primeira vez.
            "docker-compose.desktop.yml": composeFile,
          },
        },
        null,
        2,
      ),
    );

    execFileSync(process.execPath, ["--experimental-sea-config", seaConfigPath], {
      cwd: workDir,
      stdio: "inherit",
    });

    const outputPath = path.join(outDir, target.name);
    copyFileSync(process.execPath, outputPath);
    if (process.platform !== "win32") chmodSync(outputPath, 0o755);
    if (process.platform === "darwin") {
      execFileSync("codesign", ["--remove-signature", outputPath], { stdio: "inherit" });
    }

    // Invoke postject's JavaScript entrypoint through the current Node binary. The pnpm
    // shim is `postject` on POSIX but `postject.cmd` on Windows, so executing a hardcoded
    // extensionless `.bin/postject` path fails with ENOENT on the Windows release runner.
    const postjectCli = path.join(
      path.dirname(require.resolve("postject/package.json")),
      "dist",
      "cli.js",
    );
    const postjectArgs = [
      outputPath,
      "NODE_SEA_BLOB",
      blobPath,
      "--sentinel-fuse",
      SEA_SENTINEL_FUSE,
    ];
    if (process.platform === "darwin") postjectArgs.push("--macho-segment-name", "NODE_SEA");
    execFileSync(process.execPath, [postjectCli, ...postjectArgs], { stdio: "inherit" });
    if (process.platform === "darwin") {
      // Apple silicon recusa (SIGKILL, exit 137) um Mach-O sem assinatura nenhuma; depois
      // de injetar o blob, uma assinatura ad-hoc devolve um binário que roda. A release
      // pode trocar por Developer ID quando houver certificado no runner.
      execFileSync("codesign", ["--sign", "-", "--force", outputPath], { stdio: "inherit" });
    }

    // Written next to the binary so bootstrap scripts can verify SHA-256
    // before installation, the same way `buildRemoteBootstrapShell` in
    // apps/desktop/src/release-artifacts.ts already does for the
    // manifest-embedded digests.
    const sha256 = sha256File(outputPath);
    writeFileSync(`${outputPath}.sha256`, `${sha256}  ${target.name}\n`);

    return {
      release: manifest.release,
      platform: target.platform,
      arch: target.arch,
      name: target.name,
      path: outputPath,
      sha256,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function isMainModule() {
  const entry = process.argv[1];
  return Boolean(entry && path.resolve(entry) === fileURLToPath(import.meta.url));
}

function main() {
  const release = readArg("--release");
  const outDir = readArg("--out");
  const composeFile = readArg("--compose");
  if (!release) {
    console.error(
      "Usage: node scripts/build-cli-binary.mjs --release <version> [--out <dir>] [--compose <file>]",
    );
    process.exit(2);
  }
  try {
    const result = buildCliBinary(release, { outDir, composeFile });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

if (isMainModule()) {
  main();
}
