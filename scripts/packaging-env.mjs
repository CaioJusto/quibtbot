const SIGNING_ENV_NAMES = [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "WIN_CSC_LINK",
  "WIN_CSC_KEY_PASSWORD",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
];

/**
 * GitHub Actions expands an unavailable secret to an empty environment variable. Electron
 * Builder treats an empty CSC_LINK as a path, resolves it to the package directory and then
 * fails with "not a file". Omit empty signing variables while preserving real credentials.
 */
export function packagingEnvironment(source = process.env) {
  const result = { ...source };
  for (const name of SIGNING_ENV_NAMES) {
    if (!result[name]?.trim()) delete result[name];
  }
  return result;
}
