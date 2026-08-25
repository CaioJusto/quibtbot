const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { notarizationRequested, signingIdentity, submitAndStaple } = require("./notary.cjs");

exports.default = async function notarizeArtifact(event) {
  if (!notarizationRequested()) return;

  const artifactPath = event?.file ? path.resolve(event.file) : "";
  const platform = event?.packager?.platform?.name;
  if (!artifactPath || path.extname(artifactPath).toLowerCase() !== ".dmg") return;
  if (platform && platform !== "mac") return;

  console.log(`[notarize] signing ${path.basename(artifactPath)}...`);
  execFileSync("codesign", ["--force", "--timestamp", "--sign", signingIdentity(), artifactPath], {
    stdio: "inherit",
  });
  console.log(`[notarize] submitting ${path.basename(artifactPath)} to Apple...`);
  submitAndStaple(artifactPath);
  console.log("[notarize] DMG approved and stapled.");
};
