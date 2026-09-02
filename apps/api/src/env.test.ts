import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

/** O mesmo arquivo que `docs/self-host.md` manda copiar para `.env` antes do Compose. */
function publishedExampleEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(path.resolve(".env.example"), "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator > 0) values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return values;
}

const base = {
  DATABASE_URL: "postgres://quibt:quibt@127.0.0.1:5433/quibt",
  NODE_ENV: "test",
};

describe("loadEnv", () => {
  it("defaults the product path to Pi, Docker, and Graphile Worker", () => {
    const env = loadEnv(base);
    expect(env.agentRuntime).toBe("pi");
    expect(env.sandboxProvider).toBe("docker");
    expect(env.wakeupDriver).toBe("graphile");
    expect(env.edition).toBe("oss");
    expect(env.availableMachines).toEqual(["docker"]);
    expect(env.release).toBe("dev");
  });

  it("reports the deployed stack release instead of the API package version", () => {
    expect(loadEnv({ ...base, QUIBT_STACK_VERSION: "0.2.19" }).release).toBe("0.2.19");
  });

  it("keeps explicit emulator settings for pnpm verify:fast", () => {
    const env = loadEnv({
      ...base,
      AGENT_RUNTIME: "scripted",
      SANDBOX_PROVIDER: "fake",
      WAKEUP_DRIVER: "memory",
    });
    expect(env.agentRuntime).toBe("scripted");
    expect(env.sandboxProvider).toBe("fake");
    expect(env.wakeupDriver).toBe("memory");
  });

  it("loads Daytona credentials, client settings, and catalog availability", () => {
    const env = loadEnv({
      ...base,
      DAYTONA_API_KEY: "daytona_test_key",
      DAYTONA_API_URL: "https://daytona.example.test",
      DAYTONA_TARGET: "eu",
    });
    expect(env.daytonaApiKey).toBe("daytona_test_key");
    expect(env.daytonaApiUrl).toBe("https://daytona.example.test");
    expect(env.daytonaTarget).toBe("eu");
    expect(env.availableMachines).toEqual(["docker", "daytona"]);
  });

  it("throws when production omits secrets", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: base.DATABASE_URL,
        NODE_ENV: "production",
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("throws when production uses placeholder secrets", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: base.DATABASE_URL,
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "dev-secret-change-me-please-32chars",
        ENCRYPTION_KEY: "real-encryption-key-value",
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("throws when production still carries the placeholders published in .env.example", () => {
    // 37 e 38 caracteres: passavam no comprimento mínimo e a API subia com um segredo
    // que está no GitHub — dá para forjar o cookie de sessão de qualquer conta.
    expect(() =>
      loadEnv({
        DATABASE_URL: base.DATABASE_URL,
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "replace-with-32-plus-character-secret", // gitleaks:allow
        ENCRYPTION_KEY: "replace-with-64-char-hex-or-passphrase", // gitleaks:allow
        SANDBOX_SUPERVISOR_TOKEN: "supervisor-credential-with-enough-length",
        RESEND_API_KEY: "re_test",
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);
    expect(() =>
      loadEnv({
        DATABASE_URL: base.DATABASE_URL,
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
        ENCRYPTION_KEY: "replace-with-64-char-hex-or-passphrase", // gitleaks:allow
        SANDBOX_SUPERVISOR_TOKEN: "supervisor-credential-with-enough-length",
        RESEND_API_KEY: "re_test",
      }),
    ).toThrow(/ENCRYPTION_KEY/);
    expect(() =>
      loadEnv({
        DATABASE_URL: base.DATABASE_URL,
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
        ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
        SANDBOX_SUPERVISOR_TOKEN: "replace-with-32-plus-character-secret", // gitleaks:allow
        RESEND_API_KEY: "re_test",
      }),
    ).toThrow(/SANDBOX_SUPERVISOR_TOKEN/);
  });

  it("refuses the published .env.example under the production NODE_ENV the Compose pins", () => {
    expect(() => loadEnv({ ...publishedExampleEnv(), NODE_ENV: "production" })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });

  it("boots once the operator replaced every secret docs/self-host.md lists", () => {
    const env = loadEnv({
      ...publishedExampleEnv(),
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
      ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
      SANDBOX_SUPERVISOR_TOKEN: "supervisor-credential-with-enough-length",
      BOOTSTRAP_SECRET: "bootstrap-credential-with-enough-length",
      AUTH_EMAIL_DISABLED: "true",
    });
    expect(env.nodeEnv).toBe("production");
    expect(env.sandboxSupervisorToken).toBe("supervisor-credential-with-enough-length");
  });

  it("loads real secrets in production", () => {
    const env = loadEnv({
      DATABASE_URL: base.DATABASE_URL,
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
      ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
      SANDBOX_SUPERVISOR_TOKEN: "prod-supervisor-token-with-length-ok",
      BOOTSTRAP_SECRET: "prod-bootstrap-secret-with-enough-length",
      AUTH_EMAIL_DISABLED: "true",
    });
    expect(env.authSecret).toBe("prod-auth-secret-with-enough-length");
    expect(env.encryptionKey).toBe("prod-encryption-key-with-enough-length");
    expect(env.sandboxSupervisorToken).toBe("prod-supervisor-token-with-length-ok");
  });

  it("refuses to boot in production without the supervisor's own credential", () => {
    // The supervisor can create containers and run commands; it must never be
    // reachable with the session secret.
    expect(() =>
      loadEnv({
        DATABASE_URL: base.DATABASE_URL,
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
        ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
        AUTH_EMAIL_DISABLED: "true",
      }),
    ).toThrow(/SANDBOX_SUPERVISOR_TOKEN/);
  });

  it("derives a supervisor token distinct from the auth secret in development", () => {
    const env = loadEnv({ ...base, BETTER_AUTH_SECRET: "dev-machine-secret-long-enough-ok" });
    expect(env.sandboxSupervisorToken).not.toBe(env.authSecret);
    expect(env.sandboxSupervisorToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it("requires Resend when auth email is enabled in production", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: base.DATABASE_URL,
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
        ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
      }),
    ).toThrow(/Missing RESEND_API_KEY/);
  });

  it("accepts a configured Resend sender in production", () => {
    const env = loadEnv({
      DATABASE_URL: base.DATABASE_URL,
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
      ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
      SANDBOX_SUPERVISOR_TOKEN: "prod-supervisor-token-with-length-ok",
      BOOTSTRAP_SECRET: "prod-bootstrap-secret-with-enough-length",
      RESEND_API_KEY: "re_test_not_a_real_key",
    });
    expect(env.authEmailDisabled).toBe(false);
    expect(env.resendApiKey).toBe("re_test_not_a_real_key");
  });

  it("allows a self-hosted production deployment to disable auth email", () => {
    const env = loadEnv({
      DATABASE_URL: base.DATABASE_URL,
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
      ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
      SANDBOX_SUPERVISOR_TOKEN: "prod-supervisor-token-with-length-ok",
      BOOTSTRAP_SECRET: "prod-bootstrap-secret-with-enough-length",
      AUTH_EMAIL_DISABLED: "true",
    });
    expect(env.authEmailDisabled).toBe(true);
    expect(env.resendApiKey).toBeUndefined();
  });

  it("does not allow billing production to opt out of auth email", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: base.DATABASE_URL,
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
        ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
        BILLING_ENABLED: "true",
        AUTH_EMAIL_DISABLED: "true",
      }),
    ).toThrow(/Missing RESEND_API_KEY/);
  });

  it("never requires Resend in development or test", () => {
    expect(loadEnv(base).resendApiKey).toBeUndefined();
  });

  it("parses additional trusted web origins", () => {
    const env = loadEnv({
      ...base,
      TRUSTED_WEB_ORIGINS: "https://admin.example.com, https://preview.example.com ",
    });
    expect(env.trustedWebOrigins).toEqual([
      "https://admin.example.com",
      "https://preview.example.com",
    ]);
  });

  it("fails closed when billing is enabled without every Stripe setting", () => {
    expect(() => loadEnv({ ...base, BILLING_ENABLED: "true" })).toThrow(/STRIPE_SECRET_KEY/);
    expect(() =>
      loadEnv({
        ...base,
        BILLING_ENABLED: "true",
        STRIPE_SECRET_KEY: "sk_test_x",
        STRIPE_WEBHOOK_SECRET: "whsec_x",
        STRIPE_PRICE_STARTER: "price_starter",
      }),
    ).toThrow(/STRIPE_PRICE_PRO/);
  });

  it("loads all Stripe settings when billing is enabled", () => {
    const env = loadEnv({
      ...base,
      BILLING_ENABLED: "true",
      SANDBOX_PROVIDER: "e2b",
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
      STRIPE_PRICE_STARTER: "price_starter",
      STRIPE_PRICE_PRO: "price_pro",
    });
    expect(env.billingEnabled).toBe(true);
    expect(env.edition).toBe("cloud");
    expect(env.stripePricePro).toBe("price_pro");
  });

  it("refuses Cloud on the default shared Docker host", () => {
    const cloud = {
      ...base,
      QUIBT_EDITION: "cloud",
      BILLING_ENABLED: "true",
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
      STRIPE_PRICE_STARTER: "price_starter",
      STRIPE_PRICE_PRO: "price_pro",
    };
    expect(() => loadEnv(cloud)).toThrow(/share one host kernel/);
    expect(loadEnv({ ...cloud, SANDBOX_PROVIDER: "e2b" }).sandboxProvider).toBe("e2b");
    expect(loadEnv({ ...cloud, QUIBT_ALLOW_SHARED_DOCKER: "true" }).sandboxProvider).toBe("docker");
    // The self-host case Docker exists for keeps booting.
    expect(loadEnv(base).sandboxProvider).toBe("docker");
  });

  it("refuses oss with billing and cloud without billing", () => {
    expect(() =>
      loadEnv({
        ...base,
        QUIBT_EDITION: "oss",
        BILLING_ENABLED: "true",
        STRIPE_SECRET_KEY: "sk_test_x",
        STRIPE_WEBHOOK_SECRET: "whsec_x",
        STRIPE_PRICE_STARTER: "price_starter",
        STRIPE_PRICE_PRO: "price_pro",
      }),
    ).toThrow(/cannot run/);
    expect(() => loadEnv({ ...base, QUIBT_EDITION: "cloud" })).toThrow(/BILLING_ENABLED/);
  });
});
