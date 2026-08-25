import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type CreatedBootstrapEnrollment,
  type CreatedBootstrapInvite,
  createBootstrapEnrollment as createBootstrapEnrollmentPure,
  createBootstrapInvite as createBootstrapInvitePure,
} from "./bootstrap-invite.js";

function newId(): string {
  return randomBytes(16).toString("hex");
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Compares SHA-256 digests so values of different lengths never reach timingSafeEqual
 * (which throws) and no comparison short-circuits on length.
 */
export function timingSafeEqualDigest(expectedHex: string, candidateHex: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(expectedHex) || !/^[0-9a-f]{64}$/i.test(candidateHex)) {
    return false;
  }
  const expected = Buffer.from(expectedHex, "hex");
  const candidate = Buffer.from(candidateHex, "hex");
  return timingSafeEqual(expected, candidate);
}

export function createBootstrapInvite(now = new Date()): CreatedBootstrapInvite {
  return createBootstrapInvitePure(now, () => randomBytes(5), randomToken, newId);
}

export function createBootstrapEnrollment(now = new Date()): CreatedBootstrapEnrollment {
  return createBootstrapEnrollmentPure(now, randomToken);
}

export function isAuthorizedBootstrapSecret(
  suppliedSecret: string,
  expectedSecret: string,
): boolean {
  if (!suppliedSecret || !expectedSecret) return false;
  const expected = createHash("sha256").update(expectedSecret, "utf8").digest("hex");
  const candidate = createHash("sha256").update(suppliedSecret, "utf8").digest("hex");
  return timingSafeEqualDigest(expected, candidate);
}
