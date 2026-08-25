#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function spawnEnv() {
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const currentPath = process.env[pathKey] ?? process.env.PATH ?? "";
  const nodeBin = path.dirname(process.execPath);
  const pathPrefix = currentPath.split(path.delimiter).includes(nodeBin)
    ? currentPath
    : `${nodeBin}${path.delimiter}${currentPath}`;
  return { ...process.env, [pathKey]: pathPrefix };
}

const env = spawnEnv();

const vitest = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", "packages/testkit/src/installer-smoke.test.ts"],
  { cwd: root, stdio: "inherit", env },
);
if (vitest.status !== 0) {
  process.exit(vitest.status ?? 1);
}

const harness = spawnSync(
  "pnpm",
  ["exec", "tsx", "packages/testkit/src/installer-smoke.harness.ts"],
  { cwd: root, stdio: "inherit", env },
);
process.exit(harness.status ?? 1);
