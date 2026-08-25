#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifestPath = path.join(root, "assets", "release-manifest.json");

try {
  const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (raw.pipelineStatus !== "ready") {
    throw new Error(`Release manifest pipelineStatus is ${raw.pipelineStatus}, expected ready.`);
  }
  for (const artifact of ["quibtbot-linux-x64", "quibtbot-linux-arm64"]) {
    const digest = raw.digests?.[artifact];
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/i.test(digest) || /^0+$/.test(digest)) {
      throw new Error(`Release manifest digest for ${artifact} is not populated.`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
