#!/usr/bin/env node
import { createHmac } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Emite o código de primeiro dono contra a API local.
 *
 * `pnpm owner:code` é o caminho do README / SETUP_PROMPT para o navegador:
 * `cp .env.example .env`, preencher `BETTER_AUTH_SECRET` e `ENCRYPTION_KEY`,
 * `pnpm dev`, depois este comando. `BOOTSTRAP_SECRET` vazio no `.env` de
 * development é o mesmo caso da API (`resolveBootstrapSecret`): deriva de
 * `BETTER_AUTH_SECRET`. Compose em produção continua exigindo o valor próprio.
 *
 * O rótulo tem de ser o de `packages/core/src/secrets-guard.ts`.
 */
const BOOTSTRAP_SECRET_LABEL = "quibt-bot/bootstrap-secret/v1";
const DEV_AUTH_SECRET_PLACEHOLDER = "dev-secret-change-me-please-32chars";

export function isDevSecretAllowed(env = process.env) {
  if (env.QUIBT_ALLOW_DEV_SECRETS === "1") return true;
  if (env.VITEST) return true;
  const nodeEnv = env.NODE_ENV;
  return nodeEnv === "development" || nodeEnv === "test";
}

/** Mesma regra que `resolveBootstrapSecret` na API, sem importar o pacote TS. */
export function resolveMintBootstrapSecret(env = process.env) {
  const secret = env.BOOTSTRAP_SECRET?.trim();
  if (secret) return secret;
  if (!isDevSecretAllowed(env)) return null;
  const auth = env.BETTER_AUTH_SECRET?.trim() || DEV_AUTH_SECRET_PLACEHOLDER;
  return createHmac("sha256", auth).update(BOOTSTRAP_SECRET_LABEL).digest("hex");
}

export async function mintDevOwnerCode(env = process.env, fetchImpl = fetch) {
  const bootstrapSecret = resolveMintBootstrapSecret(env);
  if (!bootstrapSecret) {
    return {
      ok: false,
      message:
        "Defina BOOTSTRAP_SECRET no arquivo .env antes de emitir o código (obrigatório fora de development).",
    };
  }
  const apiUrl = (env.API_URL?.trim() || "http://127.0.0.1:3100").replace(/\/+$/, "");
  const response = await fetchImpl(`${apiUrl}/api/bootstrap/invites`, {
    method: "POST",
    headers: { "x-quibt-bootstrap-secret": bootstrapSecret },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  const body = await response?.json().catch(() => ({}));
  if (!response?.ok || typeof body?.code !== "string") {
    return {
      ok: false,
      message:
        typeof body?.message === "string"
          ? body.message
          : "Não foi possível emitir o código. Confirme que o API local está ligado.",
    };
  }
  return {
    ok: true,
    code: body.code,
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : undefined,
  };
}

export function formatMintResult(result) {
  if (!result.ok) return result.message;
  const lines = [`Código do instalador: ${result.code}`];
  if (result.expiresAt) lines.push(`Expira em: ${result.expiresAt}`);
  return lines.join("\n");
}

async function main() {
  const result = await mintDevOwnerCode();
  if (result.ok) {
    console.log(formatMintResult(result));
    return;
  }
  console.error(formatMintResult(result));
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
