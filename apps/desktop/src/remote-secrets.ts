import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";

export interface StoredSecretRecord {
  encrypted: string;
  savedAt: string;
}

export interface StoredSshCredential {
  hostname: string;
  ip: string;
  port: number;
  username: string;
  authType: "password" | "privateKey";
  encryptedSecret: string;
  encryptedPassphrase?: string;
  fingerprint: string;
  savedAt: string;
}

export interface StoredBoxServerRecord {
  boxId: string;
  savedAt: string;
}

export interface SecretSaveResult {
  ok: boolean;
  warning?: string;
}

function secretsDir(userData: string): string {
  return path.join(path.resolve(userData), "secure");
}

function secretPath(userData: string, name: string): string {
  return path.join(secretsDir(userData), `${name}.json`);
}

function ensureSecureDir(userData: string): void {
  const dir = secretsDir(userData);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function writeSecureJson(userData: string, name: string, value: unknown): void {
  ensureSecureDir(userData);
  const target = secretPath(userData, name);
  const tempTarget = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempTarget, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(tempTarget, 0o600);
  renameSync(tempTarget, target);
  chmodSync(target, 0o600);
}

function tryWriteSecureJson(userData: string, name: string, value: unknown): SecretSaveResult {
  try {
    writeSecureJson(userData, name, value);
    return { ok: true };
  } catch {
    return { ok: false, warning: "Could not persist credentials securely on this system." };
  }
}

function readSecureJson<T>(userData: string, name: string): T | null {
  const target = secretPath(userData, name);
  if (!existsSync(target)) return null;
  try {
    chmodSync(target, 0o600);
  } catch {
    return null;
  }
  try {
    return JSON.parse(readFileSync(target, "utf8")) as T;
  } catch {
    try {
      renameSync(target, `${target}.corrupt-${Date.now()}`);
    } catch {
      // ignore quarantine failures
    }
    return null;
  }
}

function tryEncrypt(
  value: string,
): { ok: true; encrypted: string } | { ok: false; warning: string } {
  if (!safeStorage.isEncryptionAvailable()) {
    return {
      ok: false,
      warning:
        "Secure credential storage is unavailable on this system; credentials were not saved.",
    };
  }
  try {
    return { ok: true, encrypted: safeStorage.encryptString(value).toString("base64") };
  } catch {
    return { ok: false, warning: "Could not encrypt credentials on this system." };
  }
}

export function encryptSecret(value: string): string {
  const result = tryEncrypt(value);
  if (!result.ok) throw new Error(result.warning);
  return result.encrypted;
}

export function decryptSecret(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure credential storage is unavailable on this system.");
  }
  return safeStorage.decryptString(Buffer.from(value, "base64"));
}

export function trySaveBoxApiKey(userData: string, apiKey: string): SecretSaveResult {
  const encrypted = tryEncrypt(apiKey);
  if (!encrypted.ok) return encrypted;
  return tryWriteSecureJson(userData, "box-api-key", {
    encrypted: encrypted.encrypted,
    savedAt: new Date().toISOString(),
  } satisfies StoredSecretRecord);
}

export function saveBoxApiKey(userData: string, apiKey: string): SecretSaveResult {
  return trySaveBoxApiKey(userData, apiKey);
}

export function loadBoxApiKey(userData: string): string | null {
  const record = readSecureJson<StoredSecretRecord>(userData, "box-api-key");
  if (!record || typeof record.encrypted !== "string") return null;
  try {
    return decryptSecret(record.encrypted);
  } catch {
    return null;
  }
}

export function clearBoxApiKey(userData: string): void {
  const target = secretPath(userData, "box-api-key");
  if (existsSync(target)) unlinkSync(target);
}

export function trySaveBoxServerId(userData: string, boxId: string): SecretSaveResult {
  return tryWriteSecureJson(userData, "box-server", {
    boxId,
    savedAt: new Date().toISOString(),
  } satisfies StoredBoxServerRecord);
}

export function loadBoxServerId(userData: string): string | null {
  const record = readSecureJson<StoredBoxServerRecord>(userData, "box-server");
  return record?.boxId ?? null;
}

export function clearBoxServerId(userData: string): void {
  const target = secretPath(userData, "box-server");
  if (existsSync(target)) unlinkSync(target);
}

export function trySaveSshCredentialPlain(
  userData: string,
  input: {
    hostname: string;
    ip: string;
    port: number;
    username: string;
    authType: "password" | "privateKey";
    secret: string;
    passphrase?: string;
    fingerprint: string;
  },
): SecretSaveResult {
  const encryptedSecret = tryEncrypt(input.secret);
  if (!encryptedSecret.ok) return encryptedSecret;
  let encryptedPassphrase: string | undefined;
  if (input.passphrase) {
    const encrypted = tryEncrypt(input.passphrase);
    if (!encrypted.ok) return encrypted;
    encryptedPassphrase = encrypted.encrypted;
  }
  return trySaveSshCredential(userData, {
    hostname: input.hostname,
    ip: input.ip,
    port: input.port,
    username: input.username,
    authType: input.authType,
    encryptedSecret: encryptedSecret.encrypted,
    ...(encryptedPassphrase ? { encryptedPassphrase } : {}),
    fingerprint: input.fingerprint,
    savedAt: new Date().toISOString(),
  });
}

export function trySaveSshCredential(
  userData: string,
  record: StoredSshCredential,
): SecretSaveResult {
  return tryWriteSecureJson(userData, "ssh-credential", record);
}

export function saveSshCredential(userData: string, record: StoredSshCredential): SecretSaveResult {
  return trySaveSshCredential(userData, record);
}

export function loadSshCredential(userData: string): StoredSshCredential | null {
  return readSecureJson<StoredSshCredential>(userData, "ssh-credential");
}

export function rehydrateSshAuth(record: StoredSshCredential): {
  authType: "password" | "privateKey";
  password?: string;
  privateKey?: string;
  passphrase?: string;
} | null {
  try {
    const secret = decryptSecret(record.encryptedSecret);
    if (record.authType === "password") return { authType: "password", password: secret };
    return {
      authType: "privateKey",
      privateKey: secret,
      ...(record.encryptedPassphrase
        ? { passphrase: decryptSecret(record.encryptedPassphrase) }
        : {}),
    };
  } catch {
    return null;
  }
}

export function clearSshCredential(userData: string): void {
  const target = secretPath(userData, "ssh-credential");
  if (existsSync(target)) unlinkSync(target);
}

export function sshCredentialLabel(record: StoredSshCredential): string {
  return `${record.username}@${record.hostname}:${record.port}`;
}
