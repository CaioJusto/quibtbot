import { describe, expect, it } from "vitest";
import { sandboxOptionsFromEnv, workerBillingEnabled, workerRuntimeConfig } from "./config.js";

describe("worker configuration", () => {
  it("passes cloud sandbox and supervisor credentials to the sandbox factory", () => {
    const options = sandboxOptionsFromEnv(
      {
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "auth-secret-that-is-long-enough-for-production",
        SANDBOX_SUPERVISOR_TOKEN: "supervisor-token-that-is-long-enough-prod",
        BOX_API_KEY: "box_live_worker_key",
        DAYTONA_API_KEY: "daytona_live_worker_key",
        DAYTONA_API_URL: "https://daytona.example.test",
        DAYTONA_TARGET: "eu",
      },
      "/data",
      { "user-1": ["/shared"] },
    );
    expect(options.boxApiKey).toBe("box_live_worker_key");
    expect(options.daytonaApiKey).toBe("daytona_live_worker_key");
    expect(options.daytonaApiUrl).toBe("https://daytona.example.test");
    expect(options.daytonaTarget).toBe("eu");
    expect(options.supervisorToken).toBe("supervisor-token-that-is-long-enough-prod");
  });

  it("uses the same billing feature flag values as the API", () => {
    expect(workerBillingEnabled({ BILLING_ENABLED: "true" })).toBe(true);
    expect(workerBillingEnabled({ BILLING_ENABLED: "1" })).toBe(true);
    expect(workerBillingEnabled({ BILLING_ENABLED: "false" })).toBe(false);
  });
});

describe("workerRuntimeConfig", () => {
  const cloud = { BILLING_ENABLED: "true", QUIBT_EDITION: "cloud" };

  it("resolves the edition the API resolves", () => {
    expect(workerRuntimeConfig({}).edition).toBe("oss");
    expect(workerRuntimeConfig({ ...cloud, SANDBOX_PROVIDER: "e2b" })).toEqual({
      edition: "cloud",
      billingEnabled: true,
      sandboxProvider: "e2b",
    });
  });

  it("refuses the incoherent boots the API refuses", () => {
    expect(() => workerRuntimeConfig(cloud)).toThrow(/share one host kernel/);
    expect(() => workerRuntimeConfig({ QUIBT_EDITION: "cloud" })).toThrow(/BILLING_ENABLED/);
    expect(() => workerRuntimeConfig({ QUIBT_EDITION: "oss", BILLING_ENABLED: "true" })).toThrow(
      /cannot run/,
    );
  });

  it("keeps the self-host default booting on Docker", () => {
    expect(workerRuntimeConfig({ NODE_ENV: "production" }).sandboxProvider).toBe("docker");
  });
});
