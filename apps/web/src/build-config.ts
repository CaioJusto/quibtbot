/**
 * Vite loads this file while evaluating `vite.config.ts`. Workspace packages
 * that export raw `.ts` stay external, so this helper cannot import
 * `@quibt/core/secrets-guard` — Node then dies with ERR_UNKNOWN_FILE_EXTENSION
 * on runtimes that do not strip types (and on Vercel if it builds the web app).
 */
const DEV_AUTH_SECRET_PLACEHOLDER = "dev-secret-change-me-please-32chars";
/** Mesma regra de `@quibt/core/secrets-guard`, repetida aqui porque o import não é possível. */
const PUBLISHED_SECRET_PREFIX = "replace-with-";
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
  if (
    !isDevSecretAllowed(env) &&
    (value === DEV_AUTH_SECRET_PLACEHOLDER || value.startsWith(PUBLISHED_SECRET_PREFIX))
  ) {
    throw new Error(RUNTIME_SECRETS_ERROR);
  }
  if (!isDevSecretAllowed(env) && value.length < 32) {
    throw new Error(RUNTIME_SECRETS_ERROR);
  }
  return value;
}

/**
 * Hosts que o `vite preview` aceita no cabeçalho Host, além dos locais que ele já
 * libera sozinho. O preview protege contra DNS rebinding recusando qualquer Host
 * desconhecido — e numa instalação pública ele não conhece o nome sslip.io que o Caddy
 * repassa: respondia 403 "Blocked request" a tudo, inclusive ao /rpc/health que o
 * celular chama. O nome vem de `WEB_ORIGIN`, que o instalador já grava como
 * `https://<host>`; fora do Docker essa variável não existe e nada muda.
 */
export function previewAllowedHosts(env: Record<string, string | undefined>): string[] {
  const hosts: string[] = [];
  for (const key of ["WEB_ORIGIN", "BETTER_AUTH_URL"]) {
    const raw = env[key]?.trim();
    if (!raw) continue;
    try {
      const host = new URL(raw).hostname;
      if (host && !hosts.includes(host)) hosts.push(host);
    } catch {
      // Uma origem malformada não pode derrubar o build; o preview segue estrito.
    }
  }
  return hosts;
}
