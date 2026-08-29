import {
  allowsSharedDocker,
  assertEditionConfig,
  assertEditionMachine,
  availableOssMachines,
  type OssMachine,
  type QuibtEdition,
  resolveAuthSecret,
  resolveBootstrapSecret,
  resolveEdition,
  resolveEncryptionKey,
  resolveSupervisorToken,
} from "@quibt/core";

export interface AppEnv {
  nodeEnv: string;
  /** Release do stack (ex.: 0.2.17), distinta da versão interna do pacote API. */
  release: string;
  databaseUrl: string;
  authSecret: string;
  authUrl: string;
  webOrigin: string;
  apiUrl: string;
  trustedWebOrigins: string[];
  trustedProxyIps: string[];
  signupsEnabled: string | undefined;
  signupAllowlist: string | undefined;
  encryptionKey: string;
  dataDir: string;
  sandboxSupervisorUrl: string;
  sandboxSupervisorToken: string;
  sandboxProvider: string;
  agentRuntime: string;
  openRouterKey: string | undefined;
  e2bApiKey: string | undefined;
  boxApiKey: string | undefined;
  composioApiKey: string | undefined;
  defaultProvider: string;
  defaultModel: string;
  wakeupDriver: string;
  port: number;
  edition: QuibtEdition;
  availableMachines: OssMachine[];
  billingEnabled: boolean;
  stripeSecretKey: string | undefined;
  stripeWebhookSecret: string | undefined;
  stripePriceStarter: string | undefined;
  stripePricePro: string | undefined;
  resendApiKey: string | undefined;
  authEmailFrom: string;
  authEmailDisabled: boolean;
  bootstrapSecret: string;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const authSecret = resolveAuthSecret(source);
  const billingEnabled = source.BILLING_ENABLED === "true" || source.BILLING_ENABLED === "1";
  const edition = resolveEdition({ edition: source.QUIBT_EDITION, billingEnabled });
  assertEditionConfig(edition, billingEnabled);
  const nodeEnv = source.NODE_ENV ?? "development";
  const sandboxProvider = source.SANDBOX_PROVIDER ?? "docker";
  const authEmailDisabled =
    source.AUTH_EMAIL_DISABLED === "true" || source.AUTH_EMAIL_DISABLED === "1";
  const resendApiKey = source.RESEND_API_KEY;
  if (nodeEnv === "production" && billingEnabled && authEmailDisabled) {
    throw new Error("Missing RESEND_API_KEY: AUTH_EMAIL_DISABLED cannot be used with billing.");
  }
  if (nodeEnv === "production" && !authEmailDisabled && !resendApiKey) {
    throw new Error("Missing RESEND_API_KEY");
  }
  const env: AppEnv = {
    nodeEnv,
    release: source.QUIBT_STACK_VERSION?.trim() || source.npm_package_version?.trim() || "dev",
    databaseUrl: required(source, "DATABASE_URL"),
    authSecret,
    authUrl: source.BETTER_AUTH_URL ?? source.WEB_ORIGIN ?? "http://127.0.0.1:5173",
    webOrigin: source.WEB_ORIGIN ?? "http://127.0.0.1:5173",
    apiUrl: source.API_URL ?? "http://127.0.0.1:3100",
    trustedWebOrigins: commaSeparated(source.TRUSTED_WEB_ORIGINS),
    trustedProxyIps: commaSeparated(source.TRUSTED_PROXY_IPS),
    signupsEnabled: source.SIGNUPS_ENABLED,
    signupAllowlist: source.SIGNUP_ALLOWLIST,
    encryptionKey: resolveEncryptionKey(source),
    dataDir: source.DATA_DIR ?? "./data",
    sandboxSupervisorUrl: source.SANDBOX_SUPERVISOR_URL ?? "http://127.0.0.1:7091",
    sandboxSupervisorToken: resolveSupervisorToken(source),
    sandboxProvider,
    agentRuntime: source.AGENT_RUNTIME ?? "pi",
    openRouterKey: source.OPENROUTER_API_KEY,
    e2bApiKey: source.E2B_API_KEY,
    boxApiKey: source.BOX_API_KEY,
    composioApiKey: source.COMPOSIO_API_KEY,
    defaultProvider: source.PI_DEFAULT_PROVIDER ?? "openrouter",
    defaultModel: source.PI_DEFAULT_MODEL ?? "deepseek/deepseek-v4-flash-0731",
    wakeupDriver: source.WAKEUP_DRIVER ?? "graphile",
    port: Number(source.API_PORT ?? 3100),
    edition,
    availableMachines: availableOssMachines({
      e2bApiKey: source.E2B_API_KEY,
      boxApiKey: source.BOX_API_KEY,
      remoteSupervisorUrl: source.SANDBOX_REMOTE_SUPERVISOR_URL,
    }),
    billingEnabled,
    stripeSecretKey: billingEnabled
      ? required(source, "STRIPE_SECRET_KEY")
      : source.STRIPE_SECRET_KEY,
    stripeWebhookSecret: billingEnabled
      ? required(source, "STRIPE_WEBHOOK_SECRET")
      : source.STRIPE_WEBHOOK_SECRET,
    stripePriceStarter: billingEnabled
      ? required(source, "STRIPE_PRICE_STARTER")
      : source.STRIPE_PRICE_STARTER,
    stripePricePro: billingEnabled ? required(source, "STRIPE_PRICE_PRO") : source.STRIPE_PRICE_PRO,
    resendApiKey,
    authEmailFrom: source.AUTH_EMAIL_FROM ?? "Quibt Bot <noreply@quibt.com.br>",
    authEmailDisabled,
    bootstrapSecret: resolveBootstrapSecret(source),
  };
  // Last, so a Cloud deploy that is also missing Stripe settings still reports those first.
  assertEditionMachine({
    edition,
    sandboxProvider,
    nodeEnv,
    allowSharedDocker: allowsSharedDocker(source),
  });
  return env;
}

function commaSeparated(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function required(source: NodeJS.ProcessEnv, key: string): string {
  const value = source[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}
