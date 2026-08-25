const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_PROFILE = "quibt-notary";
const DEFAULT_IDENTITY = "Developer ID Application: Caio Justo (9Q372SFRM8)";

function notarizationRequested(env = process.env) {
  return env.QUIBT_NOTARIZE === "1";
}

function notarytoolSubmitArgs(filePath, env = process.env) {
  const profile = env.QUIBT_NOTARY_PROFILE?.trim() || DEFAULT_PROFILE;
  return ["notarytool", "submit", filePath, "--keychain-profile", profile, "--wait"];
}

function submitAndStaple(filePath, env = process.env) {
  let submissionPath = filePath;
  let tempDir;
  if (path.extname(filePath).toLowerCase() === ".app") {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "quibt-notary-"));
    submissionPath = path.join(tempDir, `${path.basename(filePath)}.zip`);
    execFileSync(
      "ditto",
      ["-c", "-k", "--sequesterRsrc", "--keepParent", filePath, submissionPath],
      { stdio: "inherit" },
    );
  }
  try {
    execFileSync("xcrun", notarytoolSubmitArgs(submissionPath, env), { stdio: "inherit" });
    execFileSync("xcrun", ["stapler", "staple", filePath], { stdio: "inherit" });
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}

function signingIdentity(env = process.env) {
  return env.CSC_NAME?.trim() || DEFAULT_IDENTITY;
}

module.exports = {
  notarizationRequested,
  notarytoolSubmitArgs,
  signingIdentity,
  submitAndStaple,
};
