const path = require("node:path");
const { notarizationRequested, submitAndStaple } = require("./notary.cjs");

exports.default = async function notarizeApp(context) {
  if (context.electronPlatformName !== "darwin" || !notarizationRequested()) return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`[notarize] submitting ${appName}.app to Apple...`);
  submitAndStaple(appPath);
  console.log("[notarize] app approved and stapled.");
};
