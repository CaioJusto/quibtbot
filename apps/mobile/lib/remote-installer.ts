import { sha256 } from "@quibt/core/secrets-guard";
import type { InstallerEvent, InstallerEventStatus, InstallStep } from "@quibt/installer";
import { redactInstallerText } from "@quibt/installer/redact";
import {
  buildRemoteBootstrapShell,
  buildRemoteUpdateShell,
  type EmbeddedReleaseManifest,
  releaseManifestFixture,
  resolveEmbeddedReleaseArtifacts,
  selectLinuxArtifact,
  type VerifiedReleaseArtifacts,
} from "./release-artifacts.js";

export const MAX_REMOTE_LOG_CHARS = 32_768;
export const DEFAULT_REMOTE_INSTALL_TIMEOUT_MS = 30 * 60_000;

export interface RemotePairingOutput {
  url: string;
  code: string;
  token?: string;
  expiresAt?: string;
  deepLink?: string;
  qrSvg?: string;
}

export interface InstallResult {
  ok: boolean;
  url?: string;
  pairing?: RemotePairingOutput;
  error?: string;
  log?: string;
  boxId?: string;
}

export interface RemoteUpdateResult {
  ok: boolean;
  release?: string;
  previousRelease?: string;
  backupPath?: string;
  error?: string;
  log?: string;
}

export interface RemoteInstallTransport {
  inspectIdentity(): Promise<{ algorithm: string; fingerprint: string }>;
  attachCredential?(loader: () => Promise<SshTransportCredentials>): void;
  connect(expectedFingerprint: string): Promise<void>;
  runInstall(onEvent: (event: InstallerEvent) => void): Promise<InstallResult>;
  close(): Promise<void>;
}

export type SshInstallTransport = RemoteInstallTransport & {
  attachCredential(loader: () => Promise<SshTransportCredentials>): void;
  runUpdate(onEvent: (event: InstallerEvent) => void): Promise<RemoteUpdateResult>;
};

export type SshTransportCredentials =
  | { type: "password"; password: string }
  | { type: "privateKey"; privateKey: string; passphrase?: string };

export interface SshTransportConfig {
  hostname: string;
  port?: number;
  username: string;
  ip?: string;
}

export interface BoxTransportConfig {
  loadApiKey: () => Promise<string>;
  boxId?: string;
  fetch?: typeof fetch;
  release?: VerifiedReleaseArtifacts;
  onBoxAllocated?: (boxId: string) => void;
}

export interface VerifiedRemoteInstallOptions {
  expectedFingerprint: string;
  onEvent: (event: InstallerEvent) => void;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, "");
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function normalizeSha256Fingerprint(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";

  const openSsh = trimmed.match(/^SHA256:([A-Za-z0-9+/=]+)$/i);
  if (openSsh?.[1]) {
    const normalized = bytesToBase64(Uint8Array.from(atob(openSsh[1]), (c) => c.charCodeAt(0)));
    return `SHA256:${normalized}`;
  }

  if (/^[a-f0-9]{64}$/i.test(trimmed)) {
    const bytes = new Uint8Array(32);
    for (let index = 0; index < 32; index += 1) {
      bytes[index] = Number.parseInt(trimmed.slice(index * 2, index * 2 + 2), 16);
    }
    return `SHA256:${bytesToBase64(bytes)}`;
  }

  return trimmed;
}

export function fingerprintsMatch(actual: string, expected: string): boolean {
  return normalizeSha256Fingerprint(actual) === normalizeSha256Fingerprint(expected);
}

export function detectSshHostKeyAlgorithm(key: Uint8Array): string {
  if (key.length < 8) return "unknown";
  const view = new DataView(key.buffer, key.byteOffset, key.byteLength);
  const typeLen = view.getUint32(0);
  if (typeLen <= 0 || 4 + typeLen > key.length) return "unknown";
  const type = new TextDecoder().decode(key.subarray(4, 4 + typeLen)).trim();
  return type || "unknown";
}

export function fingerprintSha256FromKeyBytes(key: Uint8Array): string {
  return normalizeSha256Fingerprint(bytesToHex(sha256(key)));
}

export function normalizeSshPort(port: number | undefined): number {
  const value = port ?? 22;
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("SSH port must be an integer between 1 and 65535.");
  }
  return value;
}

export function collectTransportSecrets(
  credential?: SshTransportCredentials | string | null,
): string[] {
  if (!credential) return [];
  if (typeof credential === "string") return [credential];
  if (credential.type === "password") return [credential.password];
  const secrets = [credential.privateKey];
  if (credential.passphrase) secrets.push(credential.passphrase);
  return secrets;
}

export function sanitizeInstallerEvent(event: InstallerEvent, secrets: string[]): InstallerEvent {
  return {
    ...event,
    message: redactInstallerText(event.message, secrets),
    detail: event.detail
      ? Object.fromEntries(
          Object.entries(event.detail).map(([key, value]) => [
            key,
            typeof value === "string" ? redactInstallerText(value, secrets) : value,
          ]),
        )
      : undefined,
  };
}

function emitSanitized(
  onEvent: ((event: InstallerEvent) => void) | undefined,
  event: InstallerEvent,
  secrets: string[],
): void {
  onEvent?.(sanitizeInstallerEvent(event, secrets));
}

export function emitInstallerEvent(
  onEvent: ((event: InstallerEvent) => void) | undefined,
  event: InstallerEvent,
  secrets: string[],
): void {
  emitSanitized(onEvent, event, secrets);
}

function boundLogText(text: string): string {
  if (text.length <= MAX_REMOTE_LOG_CHARS) return text;
  return `${text.slice(0, MAX_REMOTE_LOG_CHARS)}\n[log truncated]`;
}

const INSTALLER_LINE =
  /^\[(requirements|environment|images|services|database|health|pairing)\] (running|succeeded|failed): (.*)$/;
const URL_LINE = /^URL:\s*(.+)\s*$/;
const CODE_LINE = /^Code:\s*(.+)\s*$/;
const TOKEN_LINE = /^Token:\s*(.+)\s*$/;
const EXPIRES_LINE = /^Expires:\s*(.+)\s*$/;
const DEEP_LINK_LINE = /^Deep link:\s*(.+)\s*$/i;
const SENSITIVE_LOG_LINE =
  /^(Token:|Deep link:|Expires:|<svg|quibt:\/\/|BEGIN OPENSSH PRIVATE KEY)/i;

export function parseInstallerOutput(
  combined: string,
  secrets: string[],
  onEvent?: (event: InstallerEvent) => void,
): { url?: string; pairing?: RemotePairingOutput; log: string } {
  let url: string | undefined;
  const pairing: RemotePairingOutput = { url: "", code: "" };
  const logLines: string[] = [];

  for (const rawLine of combined.split("\n")) {
    const tokenMatch = rawLine.match(TOKEN_LINE);
    if (tokenMatch?.[1]) {
      pairing.token = tokenMatch[1].trim();
      continue;
    }
    const expiresMatch = rawLine.match(EXPIRES_LINE);
    if (expiresMatch?.[1]) {
      pairing.expiresAt = expiresMatch[1].trim();
      continue;
    }
    const deepLinkMatch = rawLine.match(DEEP_LINK_LINE);
    if (deepLinkMatch?.[1]) {
      pairing.deepLink = deepLinkMatch[1].trim();
      continue;
    }
    if (rawLine.trimStart().startsWith("<svg")) {
      pairing.qrSvg = rawLine.trim();
      continue;
    }
    if (SENSITIVE_LOG_LINE.test(rawLine.trim())) continue;

    const line = redactInstallerText(rawLine, secrets);
    const match = line.match(INSTALLER_LINE);
    if (match?.[1] && match[2] && match[3]) {
      emitSanitized(
        onEvent,
        {
          step: match[1] as InstallStep,
          status: match[2] as InstallerEventStatus,
          message: match[3],
        },
        secrets,
      );
      logLines.push(line);
      continue;
    }
    const urlMatch = line.match(URL_LINE);
    if (urlMatch?.[1]) {
      url = urlMatch[1].trim();
      pairing.url = url;
      continue;
    }
    const codeMatch = line.match(CODE_LINE);
    if (codeMatch?.[1]) {
      pairing.code = codeMatch[1].trim();
      continue;
    }
    logLines.push(line);
  }

  const resolvedPairing =
    pairing.url && pairing.code ? pairing : url ? { url, code: pairing.code || "" } : undefined;

  return {
    url,
    pairing: resolvedPairing?.code
      ? resolvedPairing
      : resolvedPairing?.url
        ? resolvedPairing
        : undefined,
    log: boundLogText(logLines.join("\n").trim()),
  };
}

/**
 * O `quibtbot update` imprime os mesmos eventos do install e termina com um resumo JSON.
 * A saída passa pela mesma redação antes de chegar à tela.
 */
export function parseRemoteUpdateOutput(
  combined: string,
  secrets: string[],
  onEvent?: (event: InstallerEvent) => void,
): RemoteUpdateResult {
  const sanitized = redactInstallerText(combined, secrets);
  for (const line of sanitized.split("\n")) {
    const match = line.match(INSTALLER_LINE);
    if (match?.[1] && match[2] && match[3]) {
      emitSanitized(
        onEvent,
        {
          step: match[1] as InstallStep,
          status: match[2] as InstallerEventStatus,
          message: match[3],
        },
        secrets,
      );
    }
  }

  const candidates = sanitized.match(/\{[\s\S]*?\}/g) ?? [];
  let summary: { release?: unknown; previousRelease?: unknown; backupPath?: unknown } = {};
  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate) as typeof summary;
      if (typeof parsed.release === "string") {
        summary = parsed;
        break;
      }
    } catch {
      // Logs podem conter chaves que não são JSON; só o resumo final nos interessa.
    }
  }

  if (typeof summary.release !== "string") {
    return {
      ok: false,
      error: "A VPS terminou sem confirmar a release atualizada.",
      log: boundLogText(sanitized.trim()),
    };
  }

  return {
    ok: true,
    release: summary.release,
    ...(typeof summary.previousRelease === "string"
      ? { previousRelease: summary.previousRelease }
      : {}),
    ...(typeof summary.backupPath === "string" ? { backupPath: summary.backupPath } : {}),
    log: boundLogText(sanitized.trim()),
  };
}

export async function runVerifiedRemoteInstall(
  transport: RemoteInstallTransport,
  options: VerifiedRemoteInstallOptions,
): Promise<InstallResult> {
  const expected = options.expectedFingerprint.trim();
  if (!expected) {
    return { ok: false, error: "Expected SSH host fingerprint is required." };
  }

  try {
    await transport.connect(expected);
    const result = await transport.runInstall((event) => emitSanitized(options.onEvent, event, []));
    await transport.close().catch(() => undefined);
    return result;
  } catch (error) {
    await transport.close().catch(() => undefined);
    const message = redactInstallerText(
      error instanceof Error ? error.message : "Remote install failed",
      [],
    );
    emitSanitized(options.onEvent, { step: "requirements", status: "failed", message }, []);
    return { ok: false, error: message, log: "" };
  }
}

export async function runVerifiedRemoteUpdate(
  transport: SshInstallTransport,
  options: VerifiedRemoteInstallOptions,
): Promise<RemoteUpdateResult> {
  const expected = options.expectedFingerprint.trim();
  if (!expected) {
    return { ok: false, error: "Expected SSH host fingerprint is required." };
  }

  try {
    await transport.connect(expected);
    const result = await transport.runUpdate((event) => emitSanitized(options.onEvent, event, []));
    await transport.close().catch(() => undefined);
    return result;
  } catch (error) {
    await transport.close().catch(() => undefined);
    const message = redactInstallerText(
      error instanceof Error ? error.message : "Remote update failed",
      [],
    );
    emitSanitized(options.onEvent, { step: "requirements", status: "failed", message }, []);
    return { ok: false, error: message, log: "" };
  }
}

const SAMPLE_KEY = Uint8Array.from([
  0,
  0,
  0,
  11,
  ...new TextEncoder().encode("ssh-ed25519"),
  0,
  0,
  0,
  4,
  1,
  2,
  3,
  4,
]);

/** In-memory SSH transport for unit tests. */
export function createMockSshTransport(input: {
  release?: EmbeddedReleaseManifest;
  installOutput?: string;
  expectedFingerprint?: string;
}): SshInstallTransport {
  const fingerprint = input.expectedFingerprint ?? fingerprintSha256FromKeyBytes(SAMPLE_KEY);
  let connected = false;
  let credentials: SshTransportCredentials | undefined;
  let loadCredential: (() => Promise<SshTransportCredentials>) | undefined;

  const transport: SshInstallTransport = {
    attachCredential(loader) {
      loadCredential = loader;
    },
    async inspectIdentity() {
      return {
        algorithm: detectSshHostKeyAlgorithm(SAMPLE_KEY),
        fingerprint,
      };
    },
    async connect(expectedFingerprint) {
      if (!expectedFingerprint.trim()) {
        throw new Error("Expected SSH host fingerprint is required.");
      }
      if (!fingerprintsMatch(fingerprint, expectedFingerprint)) {
        await transport.close();
        throw new Error("SSH host fingerprint mismatch");
      }
      if (!loadCredential) {
        throw new Error("SSH credentials are required after host verification.");
      }
      credentials = await loadCredential();
      connected = true;
    },
    async runInstall(onEvent) {
      if (!connected || !credentials) throw new Error("SSH transport is not connected.");
      const release = resolveEmbeddedReleaseArtifacts(input.release);
      const secrets = collectTransportSecrets(credentials);
      emitSanitized(
        onEvent,
        { step: "requirements", status: "running", message: "Connecting to remote host" },
        secrets,
      );
      const command = buildRemoteBootstrapShell(release);
      if (!command.includes('if [ "$ACTUAL" != "$EXPECTED" ]')) {
        throw new Error("Bootstrap script missing digest verification.");
      }
      const parsed = parseInstallerOutput(
        input.installOutput ??
          "URL: https://203.0.113.10:5173\nCode: ABCDE\nToken: secret-token\nDeep link: quibt://connect?token=secret-token\n",
        secrets,
        onEvent,
      );
      emitSanitized(
        onEvent,
        { step: "health", status: "succeeded", message: "Remote install finished" },
        secrets,
      );
      return {
        ok: true,
        url: parsed.url,
        pairing: parsed.pairing?.code ? parsed.pairing : undefined,
        log: parsed.log,
      };
    },
    async runUpdate(onEvent) {
      if (!connected || !credentials) throw new Error("SSH transport is not connected.");
      const release = resolveEmbeddedReleaseArtifacts(input.release);
      const secrets = collectTransportSecrets(credentials);
      const command = buildRemoteUpdateShell(release);
      if (!command.includes('if [ "$ACTUAL" != "$EXPECTED" ]')) {
        throw new Error("Update bootstrap script missing digest verification.");
      }
      return parseRemoteUpdateOutput(
        input.installOutput ??
          '[health] succeeded: API ready\n{\n  "release": "0.2.15",\n  "previousRelease": "0.2.12",\n  "backupPath": "/var/lib/quibt/backups/pre-update"\n}\n',
        secrets,
        onEvent,
      );
    },
    async close() {
      connected = false;
      credentials = undefined;
    },
  };

  return transport;
}

export { releaseManifestFixture, resolveEmbeddedReleaseArtifacts, selectLinuxArtifact };
