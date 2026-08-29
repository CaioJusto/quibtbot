#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLinter } from "actionlint";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowsDir = path.join(root, ".github", "workflows");
const names = (await readdir(workflowsDir))
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();
const lint = await createLinter();
let failures = 0;
// actionlint's npm/WASM package carries an older built-in runner-label catalog. These are
// current GitHub-hosted labels used by the release matrix; suppress only this exact stale-
// catalog diagnostic and keep every other workflow error fatal.
const currentHostedRunnerLabels = new Set(["macos-14", "ubuntu-24.04-arm"]);

for (const name of names) {
  const file = path.join(workflowsDir, name);
  const source = await readFile(file, "utf8");
  for (const result of lint(source, path.relative(root, file))) {
    const unknownRunner =
      result.kind === "runner-label"
        ? result.message.match(/^label "([^"]+)" is unknown\./)?.[1]
        : undefined;
    if (unknownRunner && currentHostedRunnerLabels.has(unknownRunner)) continue;
    failures += 1;
    console.error(
      `${result.file}:${result.line}:${result.column}: [${result.kind}] ${result.message}`,
    );
  }
}

if (failures) {
  console.error(`actionlint found ${failures} workflow problem${failures === 1 ? "" : "s"}`);
  process.exitCode = 1;
} else {
  console.log(`actionlint checked ${names.length} workflow files`);
}
