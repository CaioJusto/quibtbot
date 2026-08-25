import { sha256 } from "./secrets-guard.js";

/** Crockford Base32 without I, L, O, U to avoid ambiguous characters. */
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const BOOTSTRAP_INVITE_TTL_MS = 10 * 60_000;
export const BOOTSTRAP_ENROLLMENT_SCOPE = "first-owner";

export interface BootstrapInviteRecord {
  id: string;
  codeHash: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
  enrollmentTokenHash?: string | null;
  enrollmentExpiresAt?: Date | null;
  enrollmentConsumedAt?: Date | null;
}

export interface CreatedBootstrapInvite {
  record: BootstrapInviteRecord;
  code: string;
  token: string;
}

export interface CreatedBootstrapEnrollment {
  token: string;
  expiresAt: Date;
  tokenHash: string;
}

export interface FirstOwnerEnrollment {
  inviteId: string;
  tokenHash: string;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** SHA-256 digest of a bootstrap secret, stored as lowercase hex. */
export function hashBootstrapSecret(value: string): string {
  return toHex(sha256(new TextEncoder().encode(value)));
}

export function encodeCrockfordBase32(bytes: Uint8Array): string {
  let buffer = 0;
  let bits = 0;
  let out = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      const index = (buffer >> bits) & 0x1f;
      out += CROCKFORD_ALPHABET[index]!;
    }
  }
  if (bits > 0) {
    const index = (buffer << (5 - bits)) & 0x1f;
    out += CROCKFORD_ALPHABET[index]!;
  }
  return out;
}

export function normalizeBootstrapCode(code: string): string {
  return code.trim().toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
}

export function createBootstrapInvite(
  now: Date,
  randomCodeBytes: () => Uint8Array,
  randomToken: () => string,
  newId: () => string,
): CreatedBootstrapInvite {
  const entropy = randomCodeBytes();
  if (entropy.length !== 5) {
    throw new Error("bootstrap invite entropy must be exactly five bytes");
  }
  const code = encodeCrockfordBase32(entropy);
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + BOOTSTRAP_INVITE_TTL_MS);
  return {
    code,
    token,
    record: {
      id: newId(),
      codeHash: hashBootstrapSecret(code),
      tokenHash: hashBootstrapSecret(token),
      expiresAt,
      consumedAt: null,
      createdAt: now,
      enrollmentTokenHash: null,
      enrollmentExpiresAt: null,
      enrollmentConsumedAt: null,
    },
  };
}

export function createBootstrapEnrollment(
  now: Date,
  randomToken: () => string,
): CreatedBootstrapEnrollment {
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + BOOTSTRAP_INVITE_TTL_MS);
  return { token, expiresAt, tokenHash: hashBootstrapSecret(token) };
}

export function isBootstrapInviteExpired(record: BootstrapInviteRecord, now = new Date()): boolean {
  return record.expiresAt.getTime() <= now.getTime();
}

export function isBootstrapInviteConsumed(record: BootstrapInviteRecord): boolean {
  return record.consumedAt !== null;
}

export function isBootstrapEnrollmentExpired(
  record: BootstrapInviteRecord,
  now = new Date(),
): boolean {
  if (!record.enrollmentExpiresAt) return true;
  return record.enrollmentExpiresAt.getTime() <= now.getTime();
}

export function isBootstrapEnrollmentConsumed(record: BootstrapInviteRecord): boolean {
  return record.enrollmentConsumedAt !== null;
}
