import { createHash, createHmac } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEV_AUTH_SECRET_PLACEHOLDER,
  DEV_ENCRYPTION_KEY_PLACEHOLDER,
  deriveSupervisorToken,
  hmacSha256,
  hmacSha256Hex,
  isPublishedPlaceholderSecret,
  resolveAuthSecret,
  resolveBootstrapSecret,
  resolveEncryptionKey,
  resolveSupervisorToken,
  sha256,
} from "./secrets-guard.js";

const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

describe("secrets-guard", () => {
  it("allows placeholders in test mode", () => {
    expect(resolveAuthSecret({ NODE_ENV: "test" })).toBe(DEV_AUTH_SECRET_PLACEHOLDER);
    expect(resolveEncryptionKey({ NODE_ENV: "test" })).toBe(DEV_ENCRYPTION_KEY_PLACEHOLDER);
  });

  it("rejects missing secrets outside local/test", () => {
    expect(() => resolveAuthSecret({ NODE_ENV: "production" })).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => resolveEncryptionKey({ NODE_ENV: "production" })).toThrow(/ENCRYPTION_KEY/);
  });

  it("rejects placeholder values outside local/test", () => {
    expect(() =>
      resolveAuthSecret({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: DEV_AUTH_SECRET_PLACEHOLDER,
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);
    expect(() =>
      resolveEncryptionKey({
        NODE_ENV: "production",
        ENCRYPTION_KEY: DEV_ENCRYPTION_KEY_PLACEHOLDER,
      }),
    ).toThrow(/ENCRYPTION_KEY/);
  });

  it("rejects short production secrets and supervisor tokens", () => {
    expect(() => resolveAuthSecret({ NODE_ENV: "production", BETTER_AUTH_SECRET: "x" })).toThrow(
      /long random strings/,
    );
    expect(() => resolveEncryptionKey({ NODE_ENV: "production", ENCRYPTION_KEY: "y" })).toThrow(
      /long random strings/,
    );
    expect(() =>
      resolveSupervisorToken({ NODE_ENV: "production", SANDBOX_SUPERVISOR_TOKEN: "z" }),
    ).toThrow(/long random strings/);
  });

  it("rejects the placeholders published in .env.example, in every resolver", () => {
    // Os exemplos do repositório têm 37 e 38 caracteres: passavam no mínimo de 32.
    const published = "replace-with-32-plus-character-secret";
    const publishedKey = "replace-with-64-char-hex-or-passphrase"; // gitleaks:allow
    expect(() =>
      resolveAuthSecret({ NODE_ENV: "production", BETTER_AUTH_SECRET: published }),
    ).toThrow(/BETTER_AUTH_SECRET/);
    expect(() =>
      resolveEncryptionKey({ NODE_ENV: "production", ENCRYPTION_KEY: publishedKey }),
    ).toThrow(/ENCRYPTION_KEY/);
    expect(() =>
      resolveSupervisorToken({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "prod-secret-with-enough-entropy-here",
        SANDBOX_SUPERVISOR_TOKEN: published,
      }),
    ).toThrow(/SANDBOX_SUPERVISOR_TOKEN/);
    expect(() =>
      resolveBootstrapSecret({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "prod-secret-with-enough-entropy-here",
        BOOTSTRAP_SECRET: published,
      }),
    ).toThrow(/BOOTSTRAP_SECRET/);
    expect(isPublishedPlaceholderSecret("replace-with-anything-written-later")).toBe(true);
    expect(isPublishedPlaceholderSecret("prod-secret-with-enough-entropy-here")).toBe(false);
  });

  it("keeps the copied .env.example working on a development machine", () => {
    // `cp .env.example .env` + `pnpm dev` continua igual: só produção recusa.
    expect(
      resolveAuthSecret({
        NODE_ENV: "development",
        BETTER_AUTH_SECRET: "replace-with-32-plus-character-secret", // gitleaks:allow
      }),
    ).toBe("replace-with-32-plus-character-secret");
    expect(
      resolveEncryptionKey({
        NODE_ENV: "development",
        ENCRYPTION_KEY: "replace-with-64-char-hex-or-passphrase", // gitleaks:allow
      }),
    ).toBe("replace-with-64-char-hex-or-passphrase");
  });

  it("accepts real secrets in production", () => {
    expect(
      resolveAuthSecret({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "prod-secret-with-enough-entropy-here",
      }),
    ).toBe("prod-secret-with-enough-entropy-here");
  });

  it("prefers the supervisor's own credential when it is set", () => {
    expect(
      resolveSupervisorToken({
        NODE_ENV: "test",
        SANDBOX_SUPERVISOR_TOKEN: "supervisor-only",
        BETTER_AUTH_SECRET: "custom-auth",
      }),
    ).toBe("supervisor-only");
  });

  it("never hands the raw auth secret to the supervisor", () => {
    const token = resolveSupervisorToken({ NODE_ENV: "test", BETTER_AUTH_SECRET: "custom-auth" });
    expect(token).not.toBe("custom-auth");
    expect(token).not.toContain("custom-auth");
    expect(token).toBe(deriveSupervisorToken("custom-auth"));
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("derives the same token in every process, and a different one per secret", () => {
    const env = { NODE_ENV: "development", BETTER_AUTH_SECRET: "one-secret-for-this-machine" };
    // API, worker and supervisor all call this with the same environment.
    expect(resolveSupervisorToken({ ...env })).toBe(resolveSupervisorToken({ ...env }));
    expect(resolveSupervisorToken({ ...env })).not.toBe(
      resolveSupervisorToken({ ...env, BETTER_AUTH_SECRET: "another-secret" }),
    );
  });

  it("refuses to boot in production without the supervisor's own credential", () => {
    expect(() =>
      resolveSupervisorToken({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "prod-secret-with-enough-entropy-here",
      }),
    ).toThrow(/SANDBOX_SUPERVISOR_TOKEN/);
  });

  it("rejects dev placeholders and the auth secret itself as the production credential", () => {
    expect(() =>
      resolveSupervisorToken({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: DEV_AUTH_SECRET_PLACEHOLDER,
      }),
    ).toThrow();
    expect(() =>
      resolveSupervisorToken({
        NODE_ENV: "production",
        SANDBOX_SUPERVISOR_TOKEN: DEV_AUTH_SECRET_PLACEHOLDER,
      }),
    ).toThrow(/SANDBOX_SUPERVISOR_TOKEN/);
    const shared = "prod-secret-with-enough-entropy-here";
    expect(() =>
      resolveSupervisorToken({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: shared,
        SANDBOX_SUPERVISOR_TOKEN: shared,
      }),
    ).toThrow(/SANDBOX_SUPERVISOR_TOKEN/);
    expect(
      resolveSupervisorToken({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: shared,
        SANDBOX_SUPERVISOR_TOKEN: "a-different-supervisor-credential-32",
      }),
    ).toBe("a-different-supervisor-credential-32");
  });
});

describe("sha256", () => {
  it("matches the published vectors", () => {
    expect(hex(sha256(encoder.encode("")))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(hex(sha256(encoder.encode("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches node:crypto across sizes, including the padding edges", () => {
    for (const size of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000]) {
      const input = new Uint8Array(size).map((_, index) => (index * 37) % 256);
      expect(hex(sha256(input))).toBe(createHash("sha256").update(input).digest("hex"));
    }
  });

  it("matches node:crypto for arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const bytes = encoder.encode(value);
        return hex(sha256(bytes)) === createHash("sha256").update(bytes).digest("hex");
      }),
      { numRuns: 200 },
    );
  });
});

describe("hmacSha256", () => {
  it("matches RFC 4231 test case 1", () => {
    const key = new Uint8Array(20).fill(0x0b);
    expect(hex(hmacSha256(key, encoder.encode("Hi There")))).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
  });

  it("matches node:crypto, including keys longer than the block size", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (key, message) => {
        return (
          hmacSha256Hex(key, message) ===
          createHmac("sha256", encoder.encode(key)).update(message).digest("hex")
        );
      }),
      { numRuns: 200 },
    );
    const longKey = "k".repeat(200);
    expect(hmacSha256Hex(longKey, "payload")).toBe(
      createHmac("sha256", longKey).update("payload").digest("hex"),
    );
  });

  it("matches node:crypto for the supervisor token derivation itself", () => {
    const secret = "one-secret-for-this-machine";
    expect(deriveSupervisorToken(secret)).toBe(
      createHmac("sha256", secret).update("quibt-bot/sandbox-supervisor/v1").digest("hex"),
    );
  });

  it("matches node:crypto for the bootstrap secret derivation itself", () => {
    const secret = "one-secret-for-this-machine";
    expect(resolveBootstrapSecret({ NODE_ENV: "development", BETTER_AUTH_SECRET: secret })).toBe(
      createHmac("sha256", secret).update("quibt-bot/bootstrap-secret/v1").digest("hex"),
    );
  });
});
