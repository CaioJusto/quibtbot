import {
  allowsSharedDocker,
  assertEditionConfig,
  assertEditionMachine,
  type QuibtEdition,
  resolveEdition,
  resolveSupervisorToken,
} from "@quibt/core";

export function sandboxOptionsFromEnv(
  env: NodeJS.ProcessEnv,
  dataDir: string,
  desktopGrantsByUser: Record<string, string[]>,
) {
  return {
    supervisorUrl: env.SANDBOX_SUPERVISOR_URL ?? "http://127.0.0.1:7091",
    supervisorToken: resolveSupervisorToken(env),
    e2bApiKey: env.E2B_API_KEY,
    boxApiKey: env.BOX_API_KEY,
    daytonaApiKey: env.DAYTONA_API_KEY,
    daytonaApiUrl: env.DAYTONA_API_URL,
    daytonaTarget: env.DAYTONA_TARGET,
    remoteSupervisorUrl: env.SANDBOX_REMOTE_SUPERVISOR_URL,
    remoteSupervisorToken: env.SANDBOX_REMOTE_SUPERVISOR_TOKEN,
    quibtCloudSessionToken: env.QUIBT_CLOUD_SESSION_TOKEN,
    quibtCloudApiUrl: env.QUIBT_CLOUD_API_URL,
    dataDir,
    desktopGrantsByUser,
  };
}

export function workerBillingEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.BILLING_ENABLED === "true" || env.BILLING_ENABLED === "1";
}

export interface WorkerRuntimeConfig {
  edition: QuibtEdition;
  billingEnabled: boolean;
  sandboxProvider: string;
}

/**
 * The worker drives the same sandboxes as the API, so it has to refuse the same configurations.
 * A worker that boots on a machine the API rejected would run every bot somewhere else.
 */
export function workerRuntimeConfig(env: NodeJS.ProcessEnv): WorkerRuntimeConfig {
  const billingEnabled = workerBillingEnabled(env);
  const edition = resolveEdition({ edition: env.QUIBT_EDITION, billingEnabled });
  assertEditionConfig(edition, billingEnabled);
  const sandboxProvider = env.SANDBOX_PROVIDER ?? "docker";
  assertEditionMachine({
    edition,
    sandboxProvider,
    nodeEnv: env.NODE_ENV ?? "development",
    allowSharedDocker: allowsSharedDocker(env),
  });
  return { edition, billingEnabled, sandboxProvider };
}
