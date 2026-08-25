/**
 * Vite loads this file while evaluating `vite.config.ts`. Workspace packages
 * that export raw `.ts` stay external, so this helper cannot import
 * `@quibt/core/secrets-guard` — Node then dies with ERR_UNKNOWN_FILE_EXTENSION
 * on runtimes that do not strip types (and on Vercel if it builds the web app).
 */
const DEV_AUTH_SECRET_PLACEHOLDER = "dev-secret-change-me-please-32chars";
const RUNTIME_SECRETS_ERROR =
  "Set BETTER_AUTH_SECRET and ENCRYPTION_KEY to long random strings before starting Quibt Bot outside local development or tests.";

function isDevSecretAllowed(env: NodeJS.ProcessEnv): boolean {
  if (env.QUIBT_ALLOW_DEV_SECRETS === "1") return true;
  if (env.VITEST) return true;
  const nodeEnv = env.NODE_ENV;
  return nodeEnv === "development" || nodeEnv === "test";
}

export function screenProxySecretFor(command: "build" | "serve", env: NodeJS.ProcessEnv): string {
  if (command === "build") return "build-does-not-start-the-screen-proxy";
  const value = env.BETTER_AUTH_SECRET;
  if (!value) {
    if (isDevSecretAllowed(env)) return DEV_AUTH_SECRET_PLACEHOLDER;
    throw new Error(RUNTIME_SECRETS_ERROR);
  }
  if (!isDevSecretAllowed(env) && value === DEV_AUTH_SECRET_PLACEHOLDER) {
    throw new Error(RUNTIME_SECRETS_ERROR);
  }
  if (!isDevSecretAllowed(env) && value.length < 32) {
    throw new Error(RUNTIME_SECRETS_ERROR);
  }
  return value;
}
