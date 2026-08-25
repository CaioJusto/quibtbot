import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { INSTALL_RELEASE } from "./compose.js";

const SECRET_KEYS = [
  "BETTER_AUTH_SECRET",
  "ENCRYPTION_KEY",
  "SANDBOX_SUPERVISOR_TOKEN",
  "BOOTSTRAP_SECRET",
  "DATABASE_PASSWORD",
] as const;

export interface InstallEnvironmentResult {
  path: string;
  created: boolean;
  values: Record<string, string>;
}

function randomSecret(): string {
  return randomBytes(32).toString("hex");
}

export function parseEnvFile(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return values;
}

function serializeEnv(values: Record<string, string>): string {
  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

function writeEnvAtomically(target: string, body: string): void {
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, body, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, target);
}

function assignDefault(values: Record<string, string>, key: string, value: string): boolean {
  if (values[key]) return false;
  values[key] = value;
  return true;
}

export function ensureInstallEnvironment(
  dataDir: string,
  publicUrl: string,
): InstallEnvironmentResult {
  mkdirSync(dataDir, { recursive: true });
  const absoluteDataDir = path.resolve(dataDir);
  const target = path.join(absoluteDataDir, "quibt.env");
  const existed = existsSync(target);
  const parsed = existed ? parseEnvFile(readFileSync(target, "utf8")) : {};
  const values: Record<string, string> = { ...parsed };

  if (values.DATA_DIR !== absoluteDataDir) values.DATA_DIR = absoluteDataDir;
  if (values.INSTALL_ENV_FILE !== target) values.INSTALL_ENV_FILE = target;

  assignDefault(values, "QUIBT_STACK_VERSION", INSTALL_RELEASE);
  assignDefault(values, "QUIBT_EDITION", "oss");
  assignDefault(values, "BILLING_ENABLED", "false");
  assignDefault(values, "AUTH_EMAIL_DISABLED", "true");
  // Self-hosted installs are private by default. The owner can explicitly open
  // registrations later; an internet-facing VPS must not create free tenants on sight.
  assignDefault(values, "SIGNUPS_ENABLED", "false");
  assignDefault(values, "SANDBOX_PROVIDER", "docker");
  assignDefault(
    values,
    "QUIBT_WEB_BIND_HOST",
    new URL(publicUrl).hostname === "127.0.0.1" || new URL(publicUrl).hostname === "localhost"
      ? "127.0.0.1"
      : "0.0.0.0",
  );

  if (!values.WEB_ORIGIN) values.WEB_ORIGIN = publicUrl;
  if (!values.BETTER_AUTH_URL) values.BETTER_AUTH_URL = publicUrl;
  if (!values.API_URL) {
    const origin = new URL(publicUrl);
    origin.port = "3100";
    values.API_URL = origin.toString().replace(/\/$/, "");
  }

  for (const key of SECRET_KEYS) {
    if (!values[key]) values[key] = randomSecret();
  }

  if (!values.DATABASE_URL) {
    values.DATABASE_URL = `postgres://quibt:${values.DATABASE_PASSWORD}@postgres:5432/quibt`;
  }

  const body = serializeEnv(values);
  if (existed && readFileSync(target, "utf8") === body) {
    return { path: target, created: false, values };
  }

  writeEnvAtomically(target, body);

  return { path: target, created: !existed, values };
}
