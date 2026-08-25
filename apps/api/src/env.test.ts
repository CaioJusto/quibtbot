import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

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
