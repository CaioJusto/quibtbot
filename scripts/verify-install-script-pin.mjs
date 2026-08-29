import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const revisionSource = await readFile("packages/core/src/install-script.ts", "utf8");
const localInstaller = await readFile("scripts/install.sh", "utf8");
const revision = /INSTALL_SCRIPT_REVISION\s*=\s*"([a-f0-9]{40})"/.exec(revisionSource)?.[1];

if (!revision) {
  throw new Error("INSTALL_SCRIPT_REVISION must be a full 40-character commit SHA.");
}

const url = `https://raw.githubusercontent.com/CaioJusto/quibtbot/${revision}/scripts/install.sh`;
const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
if (!response.ok) {
  throw new Error(`Pinned install script returned HTTP ${response.status}: ${url}`);
}
const pinnedInstaller = await response.text();

const examplePattern =
  /^# {3}curl -fsSL https:\/\/raw\.githubusercontent\.com\/CaioJusto\/quibtbot\/[^/\s]+\/scripts\/install\.sh \| sh$/gm;

function withoutSelfReferentialExample(source, label) {
  let replacements = 0;
  const normalized = source.replace(examplePattern, () => {
    replacements += 1;
    return "#   curl -fsSL <immutable-install-script-url> | sh";
  });
  if (replacements !== 1) {
    throw new Error(`${label} must contain exactly one bootstrap command example.`);
  }
  return normalized;
}

const expected = withoutSelfReferentialExample(localInstaller, "Local scripts/install.sh");
const actual = withoutSelfReferentialExample(pinnedInstaller, "Pinned scripts/install.sh");
if (actual !== expected) {
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  throw new Error(
    `Pinned install script drifted from the local script (pinned=${digest(actual)}, local=${digest(expected)}). Publish the reviewed script commit first, then advance INSTALL_SCRIPT_REVISION.`,
  );
}

console.log(`Verified scripts/install.sh against immutable revision ${revision}.`);
