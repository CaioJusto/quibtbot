import { sha256 } from "@quibt/core/secrets-guard";
import * as SecureStore from "expo-secure-store";

export type InfrastructureAuthType = "password" | "privateKey" | "boxApiKey";

export type InfrastructureCredential =
  | { type: "password"; label: string; password: string }
  | { type: "privateKey"; label: string; privateKey: string; passphrase?: string }
  | { type: "boxApiKey"; label: string; apiKey: string };

export type InfrastructureCredentialMetadata = {
  hostId: string;
  label: string;
  authType: InfrastructureAuthType;
  lastUsedAt: string;
};

export type SshCredentialTarget = {
  username: string;
  hostname: string;
  port: number;
};

export type LoadInfrastructureCredentialResult =
  | { state: "ok"; credential: InfrastructureCredential }
  | { state: "missing" }
  | { state: "reauth-required" };

const INDEX_KEY = "quibt.infra._index";
const STORAGE_PREFIX = "quibt.infra.";

export const INFRASTRUCTURE_AUTH_OPTIONS = {
  requireAuthentication: true,
  authenticationPrompt: "Desbloqueie para acessar credenciais de infraestrutura.",
} as const;

type StoredCredentialRecord = InfrastructureCredential & {
  savedAt: string;
  lastUsedAt: string;
};

/** Normaliza o identificador do host antes de derivar a chave do SecureStore. */
export function normalizeInfrastructureHost(hostId: string): string {
  const trimmed = hostId.trim().toLowerCase();
  if (!trimmed) return "";

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).hostname.replace(/\.$/, "");
    } catch {
      // fall through
    }
  }

  return trimmed.replace(/\.$/, "");
}

/** Lê o identificador salvo como `usuario@host:porta` sem aceitar um alvo ambíguo. */
export function parseSshCredentialHostId(hostId: string): SshCredentialTarget | null {
  const trimmed = hostId.trim();
  const separator = trimmed.indexOf("@");
  const portSeparator = trimmed.lastIndexOf(":");
  if (separator <= 0 || portSeparator <= separator + 1) return null;

  const username = trimmed.slice(0, separator).trim();
  const hostname = trimmed
    .slice(separator + 1, portSeparator)
    .trim()
    .replace(/^\[|\]$/g, "");
  const port = Number(trimmed.slice(portSeparator + 1));
  if (!username || !hostname || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { username, hostname, port };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Chave do SecureStore derivada do SHA-256 do host normalizado. */
export function infrastructureCredentialStorageKey(hostId: string): string {
  const normalized = normalizeInfrastructureHost(hostId);
  const digest = toHex(sha256(new TextEncoder().encode(normalized)));
  return `${STORAGE_PREFIX}${digest}`;
}

export function formatInfrastructureAuthType(authType: InfrastructureAuthType): string {
  switch (authType) {
    case "password":
      return "Senha";
    case "privateKey":
      return "Chave privada";
    case "boxApiKey":
      return "Chave Box";
  }
}

function authTypeFromCredential(credential: InfrastructureCredential): InfrastructureAuthType {
  return credential.type;
}

function metadataFromRecord(
  hostId: string,
  record: StoredCredentialRecord,
): InfrastructureCredentialMetadata {
  return {
    hostId,
    label: record.label,
    authType: authTypeFromCredential(record),
    lastUsedAt: record.lastUsedAt,
  };
}

function credentialFromRecord(record: StoredCredentialRecord): InfrastructureCredential {
  switch (record.type) {
    case "password":
      return {
        type: "password",
        label: record.label,
        password: record.password,
      };
    case "privateKey":
      return {
        type: "privateKey",
        label: record.label,
        privateKey: record.privateKey,
        ...(record.passphrase ? { passphrase: record.passphrase } : {}),
      };
    case "boxApiKey":
      return {
        type: "boxApiKey",
        label: record.label,
        apiKey: record.apiKey,
      };
  }
}

function isStoredCredentialRecord(value: unknown): value is StoredCredentialRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.label !== "string" || typeof record.savedAt !== "string") return false;
  if (typeof record.lastUsedAt !== "string") return false;
  if (record.type === "password") return typeof record.password === "string";
  if (record.type === "privateKey") return typeof record.privateKey === "string";
  if (record.type === "boxApiKey") return typeof record.apiKey === "string";
  return false;
}

async function readIndex(): Promise<InfrastructureCredentialMetadata[]> {
  try {
    const raw = await SecureStore.getItemAsync(INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is InfrastructureCredentialMetadata =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as InfrastructureCredentialMetadata).hostId === "string" &&
        typeof (entry as InfrastructureCredentialMetadata).label === "string" &&
        typeof (entry as InfrastructureCredentialMetadata).authType === "string" &&
        typeof (entry as InfrastructureCredentialMetadata).lastUsedAt === "string",
    );
  } catch {
    return [];
  }
}

async function writeIndex(rows: InfrastructureCredentialMetadata[]): Promise<void> {
  await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(rows));
}

async function removeFromIndex(hostId: string): Promise<void> {
  const rows = await readIndex();
  const next = rows.filter((row) => row.hostId !== hostId);
  if (next.length !== rows.length) await writeIndex(next);
}

async function upsertIndex(metadata: InfrastructureCredentialMetadata): Promise<void> {
  const rows = await readIndex();
  const next = rows.filter((row) => row.hostId !== metadata.hostId);
  next.push(metadata);
  next.sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt));
  await writeIndex(next);
}

async function deleteCredentialEntry(hostId: string): Promise<void> {
  const key = infrastructureCredentialStorageKey(hostId);
  await SecureStore.deleteItemAsync(key, INFRASTRUCTURE_AUTH_OPTIONS).catch(() => undefined);
  await removeFromIndex(hostId);
}

export async function listInfrastructureCredentialMetadata(): Promise<
  InfrastructureCredentialMetadata[]
> {
  return readIndex();
}

export async function saveInfrastructureCredential(
  hostId: string,
  credential: InfrastructureCredential,
): Promise<void> {
  const now = new Date().toISOString();
  const record: StoredCredentialRecord = {
    ...credential,
    savedAt: now,
    lastUsedAt: now,
  };
  const key = infrastructureCredentialStorageKey(hostId);
  await SecureStore.setItemAsync(key, JSON.stringify(record), INFRASTRUCTURE_AUTH_OPTIONS);
  await upsertIndex(metadataFromRecord(hostId, record));
}

export async function loadInfrastructureCredential(
  hostId: string,
): Promise<LoadInfrastructureCredentialResult> {
  const key = infrastructureCredentialStorageKey(hostId);

  let raw: string | null;
  try {
    raw = await SecureStore.getItemAsync(key, INFRASTRUCTURE_AUTH_OPTIONS);
  } catch {
    // Cancelar Face ID/biometria não significa que a credencial corrompeu. Apagar aqui
    // transformava um simples "agora não" em perda definitiva da senha/chave da VPS.
    return { state: "reauth-required" };
  }

  if (!raw) return { state: "missing" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await deleteCredentialEntry(hostId);
    return { state: "reauth-required" };
  }

  if (!isStoredCredentialRecord(parsed)) {
    await deleteCredentialEntry(hostId);
    return { state: "reauth-required" };
  }

  const now = new Date().toISOString();
  const refreshed: StoredCredentialRecord = { ...parsed, lastUsedAt: now };
  await SecureStore.setItemAsync(key, JSON.stringify(refreshed), INFRASTRUCTURE_AUTH_OPTIONS);
  await upsertIndex(metadataFromRecord(hostId, refreshed));

  return { state: "ok", credential: credentialFromRecord(refreshed) };
}

export async function forgetInfrastructureCredential(hostId: string): Promise<void> {
  await deleteCredentialEntry(hostId);
}
