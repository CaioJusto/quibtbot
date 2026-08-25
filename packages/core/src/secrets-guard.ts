export const DEV_AUTH_SECRET_PLACEHOLDER = "dev-secret-change-me-please-32chars";
export const DEV_ENCRYPTION_KEY_PLACEHOLDER = "dev-encryption-key";

const RUNTIME_SECRETS_ERROR =
  "Set BETTER_AUTH_SECRET and ENCRYPTION_KEY to long random strings before starting Quibt Bot outside local development or tests.";
const MIN_RUNTIME_SECRET_LENGTH = 32;

function assertStrongRuntimeSecret(value: string, env: NodeJS.ProcessEnv): void {
  if (!isDevSecretAllowed(env) && value.length < MIN_RUNTIME_SECRET_LENGTH) {
    throw new Error(RUNTIME_SECRETS_ERROR);
  }
}

export function isDevSecretAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.QUIBT_ALLOW_DEV_SECRETS === "1") return true;
  if (env.VITEST) return true;
  const nodeEnv = env.NODE_ENV;
  return nodeEnv === "development" || nodeEnv === "test";
}

export function resolveAuthSecret(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.BETTER_AUTH_SECRET;
  if (!value) {
    if (isDevSecretAllowed(env)) return DEV_AUTH_SECRET_PLACEHOLDER;
    throw new Error(RUNTIME_SECRETS_ERROR);
  }
  if (!isDevSecretAllowed(env) && value === DEV_AUTH_SECRET_PLACEHOLDER) {
    throw new Error(RUNTIME_SECRETS_ERROR);
  }
  assertStrongRuntimeSecret(value, env);
  return value;
}

export function resolveEncryptionKey(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.ENCRYPTION_KEY;
  if (!value) {
    if (isDevSecretAllowed(env)) return DEV_ENCRYPTION_KEY_PLACEHOLDER;
    throw new Error(RUNTIME_SECRETS_ERROR);
  }
  if (!isDevSecretAllowed(env) && value === DEV_ENCRYPTION_KEY_PLACEHOLDER) {
    throw new Error(RUNTIME_SECRETS_ERROR);
  }
  assertStrongRuntimeSecret(value, env);
  return value;
}

/**
 * Rótulo do domínio da derivação. Mudar isto invalida todos os tokens
 * derivados: a API, o worker e o supervisor precisam derivar o MESMO valor.
 */
const SUPERVISOR_TOKEN_LABEL = "quibt-bot/sandbox-supervisor/v1";

const SUPERVISOR_TOKEN_ERROR =
  "Set SANDBOX_SUPERVISOR_TOKEN to a long random string: the sandbox supervisor can create containers and run commands, so it needs its own credential outside local development or tests.";

/**
 * Token de serviço do supervisor de sandbox.
 *
 * Nunca devolve o `BETTER_AUTH_SECRET` cru: quem tivesse o segredo de sessão
 * falaria direto com o supervisor (criar container, `exec`, `input`) em
 * qualquer workspace. Em produção exige credencial própria e falha no boot com
 * mensagem clara; em desenvolvimento/teste (ou self-host de uma máquina só com
 * `QUIBT_ALLOW_DEV_SECRETS=1`) deriva um valor separado do segredo de auth,
 * para que API, worker e supervisor cheguem ao mesmo token sem compartilhar o
 * segredo de sessão.
 */
export function resolveSupervisorToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.SANDBOX_SUPERVISOR_TOKEN;
  if (token) {
    if (!isDevSecretAllowed(env)) {
      // Um placeholder público ou o próprio segredo de sessão não são
      // credencial própria: aceitá-los é o mesmo buraco por outro caminho.
      if (token === DEV_AUTH_SECRET_PLACEHOLDER || token === DEV_ENCRYPTION_KEY_PLACEHOLDER) {
        throw new Error(SUPERVISOR_TOKEN_ERROR);
      }
      if (env.BETTER_AUTH_SECRET && token === env.BETTER_AUTH_SECRET) {
        throw new Error(SUPERVISOR_TOKEN_ERROR);
      }
    }
    assertStrongRuntimeSecret(token, env);
    return token;
  }
  if (!isDevSecretAllowed(env)) throw new Error(SUPERVISOR_TOKEN_ERROR);
  return deriveSupervisorToken(resolveAuthSecret(env));
}

/** HMAC-SHA256 do segredo de auth com rótulo próprio, em hexadecimal. */
export function deriveSupervisorToken(authSecret: string): string {
  return hmacSha256Hex(authSecret, SUPERVISOR_TOKEN_LABEL);
}

const BOOTSTRAP_SECRET_LABEL = "quibt-bot/bootstrap-secret/v1";

const BOOTSTRAP_SECRET_ERROR =
  "Set BOOTSTRAP_SECRET to a long random string: it mints first-owner invites on loopback only, but must still be its own credential outside local development or tests.";

/** Internal secret for minting bootstrap invites on loopback. */
export function resolveBootstrapSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.BOOTSTRAP_SECRET;
  if (secret) {
    if (!isDevSecretAllowed(env)) {
      if (secret === DEV_AUTH_SECRET_PLACEHOLDER || secret === DEV_ENCRYPTION_KEY_PLACEHOLDER) {
        throw new Error(BOOTSTRAP_SECRET_ERROR);
      }
      if (env.BETTER_AUTH_SECRET && secret === env.BETTER_AUTH_SECRET) {
        throw new Error(BOOTSTRAP_SECRET_ERROR);
      }
    }
    assertStrongRuntimeSecret(secret, env);
    return secret;
  }
  if (!isDevSecretAllowed(env)) throw new Error(BOOTSTRAP_SECRET_ERROR);
  return hmacSha256Hex(resolveAuthSecret(env), BOOTSTRAP_SECRET_LABEL);
}

// ── SHA-256 / HMAC-SHA256 ────────────────────────────────────────────────────
// Implementação local, sem dependência nenhuma. `@quibt/core` é compartilhado
// com a web (Vite) e o mobile (Metro), e este arquivo ainda é carregado
// diretamente pelo Node no `vite.config.ts` da web — ou seja, não pode importar
// `node:crypto` nem outro módulo relativo. A derivação também precisa ser
// síncrona (roda na inicialização dos processos), o que descarta `crypto.subtle`.
// `secrets-guard.test.ts` confere a saída contra `node:crypto` a cada execução.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const BLOCK_BYTES = 64;

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/** Digest SHA-256 de `message`, em 32 bytes. */
export function sha256(message: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const paddedLength = (Math.floor((message.length + 8) / BLOCK_BYTES) + 1) * BLOCK_BYTES;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = message.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += BLOCK_BYTES) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let acc = h[7]!;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (acc + s1 + choice + K[i]! + w[i]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      acc = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + acc) >>> 0;
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  for (let i = 0; i < 8; i += 1) digestView.setUint32(i * 4, h[i]!);
  return digest;
}

/** HMAC-SHA256 (RFC 2104) de `message` com a chave `key`. */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const normalized = key.length > BLOCK_BYTES ? sha256(key) : key;
  const padded = new Uint8Array(BLOCK_BYTES);
  padded.set(normalized);
  const inner = new Uint8Array(BLOCK_BYTES + message.length);
  const outer = new Uint8Array(BLOCK_BYTES + 32);
  for (let i = 0; i < BLOCK_BYTES; i += 1) {
    inner[i] = padded[i]! ^ 0x36;
    outer[i] = padded[i]! ^ 0x5c;
  }
  inner.set(message, BLOCK_BYTES);
  outer.set(sha256(inner), BLOCK_BYTES);
  return sha256(outer);
}

/** HMAC-SHA256 de duas strings UTF-8, em hexadecimal minúsculo. */
export function hmacSha256Hex(key: string, message: string): string {
  const encoder = new TextEncoder();
  return toHex(hmacSha256(encoder.encode(key), encoder.encode(message)));
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}
