#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildReleaseManifest, writeReleaseManifestAtomic } from "../src/release-manifest.js";

function readArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const release = readArg("--release");
const baseUrl = readArg("--base-url");
const x64 = readArg("--x64");
const arm64 = readArg("--arm64");
const out =
  readArg("--out") ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "release-manifest.json");

if (!release || !baseUrl || !x64 || !arm64) {
  console.error(
    "Usage: generate-release-manifest --release <version> --base-url <https-url> --x64 <path> --arm64 <path> [--out <path>]",
  );
  process.exit(2);
}

try {
  const manifest = buildReleaseManifest({
    release,
    baseUrl,
    binaries: {
      "quibtbot-linux-x64": path.resolve(x64),
      "quibtbot-linux-arm64": path.resolve(arm64),
    },
  });
  const resolvedOut = path.resolve(out);
  writeReleaseManifestAtomic(resolvedOut, manifest);
  console.log(`Wrote ready release manifest to ${resolvedOut}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
