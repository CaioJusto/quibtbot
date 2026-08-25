#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function checkedDigest(value, name) {
  if (!/^sha256:[a-f0-9]{64}$/i.test(value ?? "")) {
    throw new Error(`Missing or invalid ${name} digest`);
  }
  return value.toLowerCase();
}

export function pinReleaseImages(source, digests) {
  const replacements = {
    "ghcr.io/quibt/quibt-stack:${QUIBT_STACK_VERSION:?}": `ghcr.io/quibt/quibt-stack@${checkedDigest(digests.stack, "stack")}`,
    "ghcr.io/quibt/quibt-supervisor:${QUIBT_STACK_VERSION:?}": `ghcr.io/quibt/quibt-supervisor@${checkedDigest(digests.supervisor, "supervisor")}`,
    "ghcr.io/quibt/quibt-computer:${QUIBT_STACK_VERSION:?}": `ghcr.io/quibt/quibt-computer@${checkedDigest(digests.computer, "computer")}`,
  };
  let output = source;
  for (const [tag, pinned] of Object.entries(replacements)) {
    if (!output.includes(tag)) throw new Error(`Compose image placeholder not found: ${tag}`);
    output = output.replaceAll(tag, pinned);
  }
  if (/ghcr\.io\/quibt\/[\w-]+:\$\{QUIBT_STACK_VERSION/.test(output)) {
    throw new Error("A mutable Quibt image reference remained in the release compose file");
  }
  return output;
}

function main() {
  const target = path.resolve(
    arg("--file") ?? path.join(root, "infra/compose/docker-compose.desktop.yml"),
  );
  const output = pinReleaseImages(readFileSync(target, "utf8"), {
    stack: arg("--stack"),
    supervisor: arg("--supervisor"),
    computer: arg("--computer"),
  });
  writeFileSync(target, output, "utf8");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
