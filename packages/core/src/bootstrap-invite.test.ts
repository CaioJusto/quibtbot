import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_INVITE_TTL_MS,
  createBootstrapEnrollment,
  createBootstrapInvite,
  encodeCrockfordBase32,
  hashBootstrapSecret,
  isBootstrapInviteConsumed,
  isBootstrapInviteExpired,
} from "./bootstrap-invite.js";

describe("createBootstrapInvite", () => {
  it("returns an eight-character Crockford Base32 code, opaque token, SHA-256 hashes only, and ten-minute expiry", () => {
    const now = new Date("2026-08-17T12:00:00.000Z");
    const entropy = new Uint8Array([0xab, 0xcd, 0xef, 0x01, 0x23]);
    const invite = createBootstrapInvite(
      now,
      () => entropy,
      () => "opaque-server-token-with-enough-entropy",
      () => "invite-id-1",
    );

    expect(invite.code).toHaveLength(8);
    expect(invite.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(invite.token.length).toBeGreaterThanOrEqual(32);
    expect(invite.token).not.toBe(invite.code);

    expect(invite.record.codeHash).toBe(hashBootstrapSecret(invite.code));
    expect(invite.record.tokenHash).toBe(hashBootstrapSecret(invite.token));
    expect(invite.record.codeHash).not.toBe(invite.code);
    expect(invite.record.tokenHash).not.toBe(invite.token);

    expect(invite.record.expiresAt.getTime()).toBe(now.getTime() + BOOTSTRAP_INVITE_TTL_MS);
    expect(invite.record.consumedAt).toBeNull();
    expect(invite.record.id).toBe("invite-id-1");
    expect(invite.record.createdAt).toEqual(now);
  });
});

describe("encodeCrockfordBase32", () => {
  it("encodes five bytes into eight Crockford characters", () => {
    expect(encodeCrockfordBase32(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]))).toHaveLength(8);
    expect(encodeCrockfordBase32(new Uint8Array([0, 0, 0, 0, 0]))).toBe("00000000");
  });
});

describe("hashBootstrapSecret", () => {
  it("matches node:crypto sha256 hex", () => {
    const value = "abc";
    expect(hashBootstrapSecret(value)).toBe(
      createHash("sha256").update(value, "utf8").digest("hex"),
    );
  });
});

describe("invite expiry and consumption", () => {
  const now = new Date("2026-08-17T12:00:00.000Z");

  it("detects expired invites", () => {
    const invite = createBootstrapInvite(
      now,
      () => new Uint8Array(5),
      () => "t",
      () => "id",
    );
    expect(isBootstrapInviteExpired(invite.record, now)).toBe(false);
    const later = new Date(now.getTime() + BOOTSTRAP_INVITE_TTL_MS + 1);
    expect(isBootstrapInviteExpired(invite.record, later)).toBe(true);
  });

  it("detects consumed invites", () => {
    const invite = createBootstrapInvite(
      now,
      () => new Uint8Array(5),
      () => "t",
      () => "id",
    );
    expect(isBootstrapInviteConsumed(invite.record)).toBe(false);
    invite.record.consumedAt = now;
    expect(isBootstrapInviteConsumed(invite.record)).toBe(true);
  });
});

describe("createBootstrapEnrollment", () => {
  it("hashes the enrollment token and sets ten-minute expiry", () => {
    const now = new Date("2026-08-17T12:00:00.000Z");
    const enrollment = createBootstrapEnrollment(now, () => "enrollment-token-value");
    expect(enrollment.tokenHash).toBe(hashBootstrapSecret("enrollment-token-value"));
    expect(enrollment.expiresAt.getTime()).toBe(now.getTime() + BOOTSTRAP_INVITE_TTL_MS);
  });
});
