import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  BOX_INSTALL_MISSING_EXIT_CODE,
  buildBoxHostCommand,
  buildBoxHostingPreparationShell,
  buildBoxPublicConfigurationShell,
  type InstallerEvent,
  type InstallerEventStatus,
  type InstallStep,
  parseBoxHostedUrl,
  probeBoxHostedUrl,
  redactInstallerText,
} from "@quibt/installer";
import { Client } from "ssh2";
import {
  BOX_TRIAL_SERVER_TTL_SECONDS,
  type BoxRecord,
  createServerBoxRequest,
  isServerBoxRecord,
  SERVER_BOX_NAME,
} from "./box-api.js";
import {
  buildRemoteBootstrapShell,
  type EmbeddedReleaseManifest,
  resolveEmbeddedReleaseArtifacts,
  selectLinuxArtifact,
  type VerifiedReleaseArtifacts,
} from "./release-artifacts.js";

export const BOX_API_BASE_URL = "https://ascii.dev/api/box/v1";
export { isServerBoxRecord, SERVER_BOX_NAME } from "./box-api.js";
export const BOX_ID_PATTERN = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
export const DEFAULT_REMOTE_INSTALL_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_SSH_READY_TIMEOUT_MS = 20_000;
export const DEFAULT_SSH_EXEC_TIMEOUT_MS = 30 * 60_000;
export const MAX_REMOTE_LOG_CHARS = 32_768;

export interface SshPasswordAuth {
  type: "password";
  password: string;
}

export interface SshPrivateKeyAuth {
  type: "privateKey";
  privateKey: string;
  passphrase?: string;
}

export type SshAuth = SshPasswordAuth | SshPrivateKeyAuth;

export interface SshHostInput {
  hostname: string;
  ip: string;
  port?: number;
  username: string;
  auth?: SshAuth;
}

export interface SshHostIdentity {
  hostname: string;
  ip: string;
  port: number;
  algorithm: string;
  fingerprint: string;
}

export interface BoxInstallInput {
  apiKey: string;
  boxId?: string;
}

export interface RemotePairingOutput {
  url: string;
  code: string;
  token?: string;
  expiresAt?: string;
  deepLink?: string;
  qrSvg?: string;
}

export interface RemoteInstallResult {
  ok: boolean;
  url?: string;
  pairing?: RemotePairingOutput;
  error?: string;
  log?: string;
  warning?: string;
}

export interface SshCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SshExecOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SshSessionLike {
  exec(command: string, options?: SshExecOptions): Promise<SshCommandResult>;
  end(): void;
}

export interface SshClientLike {
  connect(config: Record<string, unknown>): Promise<SshSessionLike>;
}

export interface RemoteInstallerSshDeps {
  createClient(): SshClientLike;
}

export interface RemoteInstallerDeps {
  ssh?: RemoteInstallerSshDeps;
  fetch?: typeof fetch;
  lookupHost?: typeof dnsLookup;
  timeoutMs?: number;
  signal?: AbortSignal;
  verifiedRelease?: VerifiedReleaseArtifacts;
  releaseManifest?: EmbeddedReleaseManifest;
  onBoxAllocated?: (boxId: string) => void;
}

export function normalizeSha256Fingerprint(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";

  const openSsh = trimmed.match(/^SHA256:([A-Za-z0-9+/=]+)$/i);
  if (openSsh?.[1]) {
    const normalized = Buffer.from(openSsh[1], "base64").toString("base64");
    return `SHA256:${normalized.replace(/=+$/, "")}`;
  }

  if (/^[a-f0-9]{64}$/i.test(trimmed)) {
    const base64 = Buffer.from(trimmed, "hex").toString("base64").replace(/=+$/, "");
    return `SHA256:${base64}`;
  }

  return trimmed;
}

export function fingerprintsMatch(actual: string, expected: string): boolean {
  return normalizeSha256Fingerprint(actual) === normalizeSha256Fingerprint(expected);
}

export function detectSshHostKeyAlgorithm(key: Buffer): string {
  if (key.length < 8) return "unknown";
  const typeLen = key.readUInt32BE(0);
  if (typeLen <= 0 || 4 + typeLen > key.length) return "unknown";
  const type = key
    .subarray(4, 4 + typeLen)
    .toString("utf8")
    .trim();
  return type || "unknown";
}

export function normalizeSshPort(port: number | undefined): number {
  const value = port ?? 22;
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("SSH port must be an integer between 1 and 65535.");
  }
  return value;
}

export async function resolveSshTarget(
  hostname: string,
  port = 22,
  lookup: typeof dnsLookup = dnsLookup,
): Promise<{ hostname: string; ip: string; port: number }> {
  const normalizedPort = normalizeSshPort(port);
  const trimmedHost = hostname.trim();
  if (!trimmedHost) throw new Error("SSH host is required.");
  if (isIP(trimmedHost)) {
    return { hostname: trimmedHost, ip: trimmedHost, port: normalizedPort };
  }
  const resolved = await lookup(trimmedHost, { verbatim: true });
  return { hostname: trimmedHost, ip: resolved.address, port: normalizedPort };
}

function collectSshSecrets(input: SshHostInput): string[] {
  if (!input.auth) return [];
  if (input.auth.type === "password") return [input.auth.password];
  const secrets = [input.auth.privateKey];
  if (input.auth.passphrase) secrets.push(input.auth.passphrase);
  return secrets;
}

function sshAuthConfig(auth: SshAuth): Record<string, string> {
  if (auth.type === "password") return { password: auth.password };
  return {
    privateKey: auth.privateKey,
    ...(auth.passphrase ? { passphrase: auth.passphrase } : {}),
  };
}

function sanitizeEvent(event: InstallerEvent, secrets: string[]): InstallerEvent {
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
  onEvent?.(sanitizeEvent(event, secrets));
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

function parseInstallerOutput(
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
      logLines.push(line);
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

function createRealSshClient(): SshClientLike {
  return {
    connect(config) {
      return new Promise((resolve, reject) => {
        const client = new Client();
        let settled = false;
        const finish = (error: Error | null, session?: SshSessionLike) => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve(session!);
        };

        client.on("ready", () => {
          finish(null, {
            exec(command, options) {
              return new Promise((execResolve, execReject) => {
                const timeoutMs = options?.timeoutMs ?? DEFAULT_SSH_EXEC_TIMEOUT_MS;
                let timer: NodeJS.Timeout | null = null;
                let closed = false;
                const cleanup = (stream?: { close?: () => void }) => {
                  if (closed) return;
                  closed = true;
                  if (timer) clearTimeout(timer);
                  options?.signal?.removeEventListener("abort", onAbort);
                  stream?.close?.();
                  client.end();
                };
                const onAbort = () => {
                  cleanup();
                  execReject(new Error("Remote install cancelled"));
                };
                options?.signal?.addEventListener("abort", onAbort, { once: true });

                client.exec(command, (error, stream) => {
                  if (error || !stream) {
                    cleanup();
                    execReject(error ?? new Error("SSH exec failed"));
                    return;
                  }
                  timer = setTimeout(() => {
                    cleanup(stream);
                    execReject(new Error("SSH command timed out"));
                  }, timeoutMs);
                  const chunks: Buffer[] = [];
                  const errChunks: Buffer[] = [];
                  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
                  stream.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));
                  stream.on("close", (code: number | null) => {
                    cleanup();
                    execResolve({
                      code: code ?? 1,
                      stdout: Buffer.concat(chunks).toString("utf8"),
                      stderr: Buffer.concat(errChunks).toString("utf8"),
                    });
                  });
                });
              });
            },
            end() {
              client.end();
            },
          });
        });
        client.on("error", (error) => finish(error));
        client.connect(config as Parameters<Client["connect"]>[0]);
      });
    },
  };
}

function sshClient(deps?: RemoteInstallerDeps): SshClientLike {
  return deps?.ssh?.createClient() ?? createRealSshClient();
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Remote install cancelled");
}

function verifiedRelease(deps?: RemoteInstallerDeps): VerifiedReleaseArtifacts {
  if (deps?.verifiedRelease) return deps.verifiedRelease;
  return resolveEmbeddedReleaseArtifacts(deps?.releaseManifest);
}

export async function inspectSshHost(
  input: Pick<SshHostInput, "hostname" | "port" | "username"> & { host?: string },
  deps?: RemoteInstallerDeps,
): Promise<SshHostIdentity> {
  assertNotAborted(deps?.signal);
  const hostname = input.hostname ?? input.host ?? "";
  const target = await resolveSshTarget(hostname, input.port, deps?.lookupHost);
  const client = sshClient(deps);
  let algorithm = "unknown";
  let fingerprint = "";

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out while reading SSH host fingerprint"));
    }, DEFAULT_SSH_READY_TIMEOUT_MS);

    void client
      .connect({
        host: target.ip,
        port: target.port,
        username: input.username,
        readyTimeout: DEFAULT_SSH_READY_TIMEOUT_MS,
        hostVerifier: (key: Buffer) => {
          algorithm = detectSshHostKeyAlgorithm(key);
          fingerprint = normalizeSha256Fingerprint(createHash("sha256").update(key).digest("hex"));
          return false;
        },
      })
      .then(() => {
        clearTimeout(timer);
        if (fingerprint) resolve();
        else reject(new Error("SSH host fingerprint was not returned"));
      })
      .catch((error: Error) => {
        clearTimeout(timer);
        if (fingerprint) resolve();
        else reject(error);
      });
  });

  return { ...target, algorithm, fingerprint };
}

async function detectRemoteLinuxArtifact(
  session: SshSessionLike,
  signal?: AbortSignal,
): Promise<string> {
  const result = await session.exec("uname -m", { signal, timeoutMs: 30_000 });
  const machine = result.stdout.trim();
  const artifact = selectLinuxArtifact(machine);
  if (!artifact) throw new Error(`Unsupported remote architecture: ${machine || "unknown"}`);
  return artifact;
}

export async function installOverVerifiedSsh(
  input: SshHostInput,
  expectedFingerprint: string,
  onEvent: (event: InstallerEvent) => void,
  deps?: RemoteInstallerDeps,
): Promise<RemoteInstallResult> {
  assertNotAborted(deps?.signal);
  if (!input.auth) {
    return { ok: false, error: "SSH credentials are required after host verification." };
  }
  if (!expectedFingerprint.trim()) {
    return { ok: false, error: "Expected SSH host fingerprint is required." };
  }

  const secrets = collectSshSecrets(input);
  const port = normalizeSshPort(input.port);
  emitSanitized(
    onEvent,
    {
      step: "requirements",
      status: "running",
      message: `Connecting to ${input.hostname} (${input.ip})`,
    },
    secrets,
  );

  try {
    const release = verifiedRelease(deps);
    emitSanitized(
      onEvent,
      { step: "requirements", status: "running", message: "Verified release checksums" },
      secrets,
    );

    const session = await sshClient(deps).connect({
      host: input.ip,
      port,
      username: input.username,
      ...sshAuthConfig(input.auth),
      hostHash: "sha256",
      readyTimeout: DEFAULT_SSH_READY_TIMEOUT_MS,
      hostVerifier: (hexFingerprint: string) =>
        fingerprintsMatch(hexFingerprint, expectedFingerprint),
    });

    emitSanitized(
      onEvent,
      { step: "requirements", status: "succeeded", message: "SSH host verified" },
      secrets,
    );

    await detectRemoteLinuxArtifact(session, deps?.signal);
    emitSanitized(
      onEvent,
      { step: "images", status: "running", message: "Downloading and verifying quibtbot" },
      secrets,
    );

    const command = buildRemoteBootstrapShell(release);
    const result = await session.exec(command, {
      signal: deps?.signal,
      timeoutMs: deps?.timeoutMs ?? DEFAULT_REMOTE_INSTALL_TIMEOUT_MS,
    });
    session.end();

    const combined = `${result.stdout}\n${result.stderr}`;
    const parsed = parseInstallerOutput(combined, secrets, onEvent);

    if (result.code !== 0) {
      return {
        ok: false,
        error: redactInstallerText(result.stderr || "Remote install command failed", secrets),
        log: parsed.log,
        url: parsed.url,
        pairing: parsed.pairing?.code ? parsed.pairing : undefined,
      };
    }

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
  } catch (error) {
    const message = redactInstallerText(
      error instanceof Error ? error.message : "SSH install failed",
      secrets,
    );
    emitSanitized(onEvent, { step: "requirements", status: "failed", message }, secrets);
    return { ok: false, error: message, log: "" };
  }
}

export function isValidBoxId(boxId: string): boolean {
  return BOX_ID_PATTERN.test(boxId);
}

class BoxApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "BoxApiRequestError";
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boxApiErrorFields(body: unknown): { code?: string; detail?: string } {
  if (!body || typeof body !== "object") return {};
  const record = body as Record<string, unknown>;
  const nested =
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : undefined;
  const errorString = nonEmptyString(record.error);
  const code =
    nonEmptyString(record.code) ??
    nonEmptyString(record.errorCode) ??
    nonEmptyString(nested?.code) ??
    (errorString?.match(/^[a-z][a-z0-9_]+$/i) ? errorString : undefined);
  const detail =
    nonEmptyString(record.message) ??
    nonEmptyString(record.detail) ??
    nonEmptyString(nested?.message) ??
    (errorString !== code ? errorString : undefined);
  return { code, detail };
}

function boxApiErrorMessage(status: number, code?: string): string {
  if (status === 401 || status === 403) {
    return "A chave da Box foi recusada. Crie uma chave válida em box.ascii.dev; chaves da Hetzner não funcionam neste campo.";
  }
  if (code === "trial_auto_stop_required") {
    return "O trial da Box exige desligamento automático de no máximo 2 horas.";
  }
  if (status === 402) {
    return "A conta Box está sem saldo ou precisa concluir a configuração de cobrança.";
  }
  if (status === 429) {
    return "A Box atingiu o limite temporário de criação de máquinas. Aguarde um pouco e tente novamente.";
  }
  return `A Box recusou a solicitação (HTTP ${status})${code ? `. Código: ${code}` : ""}.`;
}

function isTrialAutoStopError(error: unknown): error is BoxApiRequestError {
  if (!(error instanceof BoxApiRequestError)) return false;
  if (error.code === "trial_auto_stop_required") return true;
  const detail = error.detail?.toLowerCase() ?? "";
  return (
    detail.includes("trial") &&
    (detail.includes("auto-stop") || detail.includes("auto stop") || detail.includes("ttl"))
  );
}

async function boxRequest<T>(
  apiKey: string,
  method: string,
  path: string,
  options: { body?: unknown; fetchImpl: typeof fetch; signal?: AbortSignal },
): Promise<T> {
  const response = await options.fetchImpl(`${BOX_API_BASE_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    signal: options.signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined);
    const fields = boxApiErrorFields(body);
    throw new BoxApiRequestError(
      boxApiErrorMessage(response.status, fields.code),
      response.status,
      fields.code,
      fields.detail,
    );
  }
  return (await response.json()) as T;
}

async function waitForBoxReady(
  apiKey: string,
  boxId: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_REMOTE_INSTALL_TIMEOUT_MS,
): Promise<BoxRecord> {
  const started = Date.now();
  for (;;) {
    assertNotAborted(signal);
    const body = await boxRequest<{ box: BoxRecord }>(apiKey, "GET", `/boxes/${boxId}`, {
      fetchImpl,
      signal,
    });
    if (!isServerBoxRecord(body.box)) {
      throw new Error("The selected Box is not a Quibt server VM.");
    }
    if (["ready", "idle", "running"].includes(body.box.state)) return body.box;
    if (body.box.state === "archived") {
      await boxRequest(apiKey, "POST", `/boxes/${boxId}/resume`, { body: {}, fetchImpl, signal });
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Box ${boxId} did not become ready in time`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function configureServerBox(
  apiKey: string,
  boxId: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<void> {
  await boxRequest(apiKey, "PATCH", `/boxes/${boxId}`, {
    body: { name: SERVER_BOX_NAME },
    fetchImpl,
    signal,
  });
}

async function allocateServerBoxId(
  input: BoxInstallInput,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
  onAllocated?: (boxId: string) => void,
  onTrialFallback?: () => void,
): Promise<string> {
  if (input.boxId) {
    if (!isValidBoxId(input.boxId)) throw new Error("Invalid Box server id.");
    onAllocated?.(input.boxId);
    return input.boxId;
  }

  const listed = await boxRequest<{ boxes: BoxRecord[] }>(input.apiKey, "GET", "/boxes", {
    fetchImpl,
    signal,
  });
  const existing = listed.boxes.find((box) => isServerBoxRecord(box));
  if (existing) {
    onAllocated?.(existing.id);
    return existing.id;
  }

  let created: { box: BoxRecord };
  try {
    created = await boxRequest<{ box: BoxRecord }>(input.apiKey, "POST", "/boxes", {
      body: createServerBoxRequest(),
      fetchImpl,
      signal,
    });
  } catch (error) {
    if (!isTrialAutoStopError(error)) throw error;
    onTrialFallback?.();
    created = await boxRequest<{ box: BoxRecord }>(input.apiKey, "POST", "/boxes", {
      body: createServerBoxRequest(BOX_TRIAL_SERVER_TTL_SECONDS),
      fetchImpl,
      signal,
    });
  }
  onAllocated?.(created.box.id);
  await configureServerBox(input.apiKey, created.box.id, fetchImpl, signal);
  return created.box.id;
}

async function resolveServerBox(
  input: BoxInstallInput,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
  onAllocated?: (boxId: string) => void,
  onTrialFallback?: () => void,
): Promise<BoxRecord> {
  const boxId = await allocateServerBoxId(input, fetchImpl, signal, onAllocated, onTrialFallback);
  return waitForBoxReady(input.apiKey, boxId, fetchImpl, signal);
}

async function interruptBox(
  apiKey: string,
  boxId: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<void> {
  await boxRequest(apiKey, "POST", `/boxes/${boxId}/interrupt`, { fetchImpl, signal });
}

async function runBoxDetachedInstall(
  apiKey: string,
  boxId: string,
  command: string,
  secrets: string[],
  onEvent: ((event: InstallerEvent) => void) | undefined,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const started = await boxRequest<{
    processId: number;
    success: boolean;
  }>(apiKey, "POST", `/boxes/${boxId}/commands`, {
    body: { command, detached: true, timeoutSeconds: 600 },
    fetchImpl,
    signal,
  });

  let seenStdout = "";
  while (true) {
    assertNotAborted(signal);
    const status = await boxRequest<{
      running: boolean;
      exitCode: number | null;
      stdout: string;
      stderr: string;
    }>(apiKey, "GET", `/boxes/${boxId}/commands/${started.processId}?tailBytes=65536`, {
      fetchImpl,
      signal,
    });

    const delta = status.stdout.slice(seenStdout.length);
    if (delta) {
      parseInstallerOutput(delta, secrets, onEvent);
      seenStdout = status.stdout;
    }

    if (!status.running) {
      return {
        exitCode: status.exitCode ?? 1,
        stdout: status.stdout,
        stderr: status.stderr,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

export async function installOnBox(
  input: BoxInstallInput,
  onEvent: (event: InstallerEvent) => void,
  deps?: RemoteInstallerDeps,
): Promise<RemoteInstallResult & { boxId?: string }> {
  assertNotAborted(deps?.signal);
  const fetchImpl = deps?.fetch ?? fetch;
  const secrets = [input.apiKey];
  let activeBoxId: string | undefined;

  emitSanitized(
    onEvent,
    { step: "requirements", status: "running", message: "Preparing Box server" },
    secrets,
  );
  try {
    const box = await resolveServerBox(input, fetchImpl, deps?.signal, deps?.onBoxAllocated, () =>
      emitSanitized(
        onEvent,
        {
          step: "requirements",
          status: "running",
          message: "Trial da Box: servidor de teste ativo por até 2 horas",
        },
        secrets,
      ),
    );
    activeBoxId = box.id;
    emitSanitized(
      onEvent,
      { step: "requirements", status: "succeeded", message: "Box server ready" },
      secrets,
    );
    emitSanitized(
      onEvent,
      {
        step: "services",
        status: "running",
        message: "Conferindo a instalação existente na Box",
      },
      secrets,
    );

    const runBoxCommand = (command: string) =>
      runBoxDetachedInstall(
        input.apiKey,
        box.id,
        command,
        secrets,
        onEvent,
        fetchImpl,
        deps?.signal,
      ).catch(async (error) => {
        if (activeBoxId && deps?.signal?.aborted) {
          await interruptBox(input.apiKey, activeBoxId, fetchImpl).catch(() => undefined);
        }
        throw error;
      });

    let preparation = await runBoxCommand(buildBoxHostingPreparationShell());
    const logs: string[] = [];

    if (preparation.exitCode === BOX_INSTALL_MISSING_EXIT_CODE) {
      emitSanitized(
        onEvent,
        {
          step: "images",
          status: "running",
          message: "Running verified bootstrap on Box (detached)",
        },
        secrets,
      );
      const release = verifiedRelease(deps);
      const bootstrap = await runBoxCommand(buildRemoteBootstrapShell(release));
      const parsedBootstrap = parseInstallerOutput(
        `${bootstrap.stdout}\n${bootstrap.stderr}`,
        secrets,
      );
      if (parsedBootstrap.log) logs.push(parsedBootstrap.log);
      if (bootstrap.exitCode !== 0) {
        return {
          ok: false,
          error: redactInstallerText(parsedBootstrap.log || "Box install command failed", secrets),
          log: logs.join("\n"),
          boxId: box.id,
        };
      }
      preparation = await runBoxCommand(buildBoxHostingPreparationShell());
    }

    const parsedPreparation = parseInstallerOutput(
      `${preparation.stdout}\n${preparation.stderr}`,
      secrets,
    );
    if (parsedPreparation.log) logs.push(parsedPreparation.log);
    if (preparation.exitCode !== 0) {
      return {
        ok: false,
        error: redactInstallerText(
          parsedPreparation.log || "Não consegui preparar a instalação existente na Box.",
          secrets,
        ),
        log: logs.join("\n"),
        boxId: box.id,
      };
    }

    emitSanitized(
      onEvent,
      {
        step: "services",
        status: "running",
        message: "Publicando o Quibt com HTTPS pela Box",
      },
      secrets,
    );
    const hosted = await runBoxCommand(buildBoxHostCommand());
    const parsedHosted = parseInstallerOutput(`${hosted.stdout}\n${hosted.stderr}`, secrets);
    if (parsedHosted.log) logs.push(parsedHosted.log);
    const publicUrl = parseBoxHostedUrl(`${hosted.stdout}\n${hosted.stderr}`);
    if (hosted.exitCode !== 0 || !publicUrl) {
      return {
        ok: false,
        error: redactInstallerText(
          parsedHosted.log ||
            "A Box não confirmou a URL HTTPS pública da instalação. A máquina foi preservada.",
          secrets,
        ),
        log: logs.join("\n"),
        boxId: box.id,
      };
    }

    const configured = await runBoxCommand(buildBoxPublicConfigurationShell(publicUrl));
    const parsed = parseInstallerOutput(`${configured.stdout}\n${configured.stderr}`, secrets);
    if (parsed.log) logs.push(parsed.log);
    if (configured.exitCode !== 0) {
      return {
        ok: false,
        error: redactInstallerText(
          parsed.log || "Não consegui concluir a configuração pública da Box.",
          secrets,
        ),
        log: logs.join("\n"),
        boxId: box.id,
      };
    }

    const publiclyHealthy = await probeBoxHostedUrl(publicUrl, fetchImpl, {
      signal: deps?.signal,
    });
    if (!publiclyHealthy) {
      return {
        ok: false,
        error:
          "A Box publicou o endereço, mas o Quibt ainda não respondeu pela internet. A máquina e os dados foram preservados; tente novamente.",
        log: logs.join("\n"),
        boxId: box.id,
      };
    }

    emitSanitized(
      onEvent,
      { step: "health", status: "succeeded", message: `Quibt disponível em ${publicUrl}` },
      secrets,
    );
    return {
      ok: true,
      url: publicUrl,
      pairing:
        parsed.pairing?.code && parsed.pairing.url === publicUrl ? parsed.pairing : undefined,
      log: logs.join("\n"),
      boxId: box.id,
    };
  } catch (error) {
    if (activeBoxId && deps?.signal?.aborted) {
      await interruptBox(input.apiKey, activeBoxId, fetchImpl).catch(() => undefined);
    }
    const message = redactInstallerText(
      error instanceof Error ? error.message : "Box install failed",
      secrets,
    );
    emitSanitized(onEvent, { step: "requirements", status: "failed", message }, secrets);
    return { ok: false, error: message, log: "", boxId: activeBoxId };
  }
}

export async function cancelBoxInstall(
  apiKey: string,
  boxId: string,
  fetchImpl: typeof fetch = fetch,
  options?: { timeoutMs?: number },
): Promise<void> {
  if (!isValidBoxId(boxId)) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 10_000);
  try {
    await interruptBox(apiKey, boxId, fetchImpl, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export {
  buildRemoteBootstrapShell,
  guidedVpsBootstrapCommand,
  releaseManifestFixture,
} from "./release-artifacts.js";
