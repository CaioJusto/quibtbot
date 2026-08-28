import type { InstallerEvent } from "@quibt/installer";
import {
  BOX_API_BASE_URL,
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
} from "./release-artifacts.js";
import {
  emitInstallerEvent,
  type InstallResult,
  parseInstallerOutput,
  type RemoteInstallTransport,
} from "./remote-installer.js";

export const BOX_ID_PATTERN = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
const TRIAL_ORPHAN_RECOVERY_WINDOW_MS = 30 * 60_000;
const TRIAL_TTL_DRIFT_MS = 2 * 60_000;
const ACTIVE_BOX_STATES = new Set([
  "init",
  "provisioning",
  "provisioned",
  "cloning",
  "ready",
  "idle",
  "running",
]);

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

function isNotFoundError(error: unknown): error is BoxApiRequestError {
  return error instanceof BoxApiRequestError && error.status === 404;
}

function isRecoverableTrialServerCandidate(box: BoxRecord, now = Date.now()): boolean {
  if (!ACTIVE_BOX_STATES.has(box.state)) return false;
  if (box.name === SERVER_BOX_NAME) return true;
  if (!box.name?.startsWith("Box ")) return false;

  const createdAt = Date.parse(box.createdAt ?? "");
  const archiveAfter = Date.parse(box.archiveAfter ?? "");
  if (!Number.isFinite(createdAt) || !Number.isFinite(archiveAfter)) return false;
  const age = now - createdAt;
  const ttl = archiveAfter - createdAt;
  return (
    age >= 0 &&
    age <= TRIAL_ORPHAN_RECOVERY_WINDOW_MS &&
    Math.abs(ttl - BOX_TRIAL_SERVER_TTL_SECONDS * 1_000) <= TRIAL_TTL_DRIFT_MS
  );
}

async function boxRequest<T>(
  loadApiKey: () => Promise<string>,
  method: string,
  path: string,
  options: { body?: unknown; fetchImpl: typeof fetch; signal?: AbortSignal },
): Promise<T> {
  const apiKey = await loadApiKey();
  if (!apiKey.trim()) throw new Error("Box API key is required.");
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
  loadApiKey: () => Promise<string>,
  boxId: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
  timeoutMs = 30 * 60_000,
): Promise<BoxRecord> {
  const started = Date.now();
  for (;;) {
    if (signal?.aborted) throw new Error("Remote install cancelled");
    const body = await boxRequest<{ box: BoxRecord }>(loadApiKey, "GET", `/boxes/${boxId}`, {
      fetchImpl,
      signal,
    });
    if (body.box.id !== boxId) {
      throw new Error("A Box respondeu com um identificador diferente do solicitado.");
    }
    if (["ready", "idle", "running"].includes(body.box.state)) return body.box;
    if (body.box.state === "error") {
      throw new Error("A Box não conseguiu preparar a máquina. Verifique o painel da Box.");
    }
    if (body.box.state === "archived") {
      await boxRequest(loadApiKey, "POST", `/boxes/${boxId}/resume`, {
        body: {},
        fetchImpl,
        signal,
      });
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Box ${boxId} did not become ready in time`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function configureServerBox(
  loadApiKey: () => Promise<string>,
  boxId: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<void> {
  await boxRequest(loadApiKey, "PATCH", `/boxes/${boxId}`, {
    body: { name: SERVER_BOX_NAME },
    fetchImpl,
    signal,
  });
}

async function allocateServerBoxId(
  loadApiKey: () => Promise<string>,
  boxId: string | undefined,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
  onAllocated?: (id: string) => void | Promise<void>,
  onTrialFallback?: () => void,
): Promise<string> {
  if (boxId) {
    if (!isValidBoxId(boxId)) throw new Error("Invalid Box server id.");
    try {
      await boxRequest(loadApiKey, "GET", `/boxes/${boxId}`, { fetchImpl, signal });
      await onAllocated?.(boxId);
      return boxId;
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }

  const listed = await boxRequest<{ boxes: BoxRecord[] }>(loadApiKey, "GET", "/boxes", {
    fetchImpl,
    signal,
  });
  const existing = listed.boxes.find((box) => isServerBoxRecord(box));
  if (existing) {
    await onAllocated?.(existing.id);
    return existing.id;
  }

  const recoveryCandidates = listed.boxes.filter((box) => isRecoverableTrialServerCandidate(box));
  const recovered = recoveryCandidates.length === 1 ? recoveryCandidates[0] : undefined;
  if (recovered) {
    await onAllocated?.(recovered.id);
    await configureServerBox(loadApiKey, recovered.id, fetchImpl, signal);
    return recovered.id;
  }
  if (recoveryCandidates.length > 1) {
    throw new Error(
      "Encontrei mais de uma Box recente. Abra o painel da Box e mantenha somente a máquina do servidor Quibt antes de tentar novamente.",
    );
  }

  let created: { box: BoxRecord };
  try {
    created = await boxRequest<{ box: BoxRecord }>(loadApiKey, "POST", "/boxes", {
      body: createServerBoxRequest(),
      fetchImpl,
      signal,
    });
  } catch (error) {
    if (!isTrialAutoStopError(error)) throw error;
    onTrialFallback?.();
    created = await boxRequest<{ box: BoxRecord }>(loadApiKey, "POST", "/boxes", {
      body: createServerBoxRequest(BOX_TRIAL_SERVER_TTL_SECONDS),
      fetchImpl,
      signal,
    });
  }
  await onAllocated?.(created.box.id);
  await configureServerBox(loadApiKey, created.box.id, fetchImpl, signal);
  return created.box.id;
}

async function runBoxDetachedInstall(
  loadApiKey: () => Promise<string>,
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
  }>(loadApiKey, "POST", `/boxes/${boxId}/commands`, {
    body: { command, detached: true, timeoutSeconds: 600 },
    fetchImpl,
    signal,
  });

  let seenStdout = "";
  while (true) {
    if (signal?.aborted) throw new Error("Remote install cancelled");
    const status = await boxRequest<{
      running: boolean;
      exitCode: number | null;
      stdout: string;
      stderr: string;
    }>(loadApiKey, "GET", `/boxes/${boxId}/commands/${started.processId}?tailBytes=65536`, {
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

export interface BoxInstallTransportOptions {
  loadApiKey: () => Promise<string>;
  boxId?: string;
  fetch?: typeof fetch;
  release?: EmbeddedReleaseManifest;
  onBoxAllocated?: (boxId: string) => void | Promise<void>;
  signal?: AbortSignal;
}

export async function runBoxRemoteInstall(
  transport: RemoteInstallTransport,
  onEvent: (event: InstallerEvent) => void,
): Promise<InstallResult> {
  try {
    await transport.connect("box-api");
    const result = await transport.runInstall(onEvent);
    await transport.close().catch(() => undefined);
    return result;
  } catch (error) {
    await transport.close().catch(() => undefined);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Box install failed",
      log: "",
    };
  }
}

export function createBoxInstallTransport(
  options: BoxInstallTransportOptions,
): RemoteInstallTransport {
  let activeBoxId: string | undefined;

  return {
    async inspectIdentity() {
      return { algorithm: "box", fingerprint: "box-api" };
    },
    async connect(_expectedFingerprint: string) {
      const apiKey = await options.loadApiKey();
      if (!apiKey.trim()) throw new Error("Box API key is required.");
    },
    async runInstall(onEvent) {
      const fetchImpl = options.fetch ?? fetch;
      const release = resolveEmbeddedReleaseArtifacts(options.release);
      const secrets: string[] = [];

      emitInstallerEvent(
        onEvent,
        {
          step: "requirements",
          status: "running",
          message: "Preparing Box server",
        },
        secrets,
      );

      activeBoxId = await allocateServerBoxId(
        options.loadApiKey,
        options.boxId,
        fetchImpl,
        options.signal,
        options.onBoxAllocated,
        () =>
          emitInstallerEvent(
            onEvent,
            {
              step: "requirements",
              status: "running",
              message: "Trial da Box: servidor de teste ativo por até 2 horas",
            },
            secrets,
          ),
      );

      const box = await waitForBoxReady(options.loadApiKey, activeBoxId, fetchImpl, options.signal);
      emitInstallerEvent(
        onEvent,
        {
          step: "requirements",
          status: "succeeded",
          message: "Box server ready",
        },
        secrets,
      );
      emitInstallerEvent(
        onEvent,
        {
          step: "images",
          status: "running",
          message: "Running verified bootstrap on Box (detached)",
        },
        secrets,
      );

      const command = buildRemoteBootstrapShell(release);
      const result = await runBoxDetachedInstall(
        options.loadApiKey,
        box.id,
        command,
        secrets,
        onEvent,
        fetchImpl,
        options.signal,
      );

      const parsed = parseInstallerOutput(`${result.stdout}\n${result.stderr}`, secrets);
      const url = parsed.url ?? (box.url ? String(box.url) : undefined);

      if (result.exitCode !== 0) {
        return {
          ok: false,
          error: parsed.log || "Box install command failed",
          log: parsed.log,
          url,
          pairing: parsed.pairing?.code ? parsed.pairing : undefined,
          boxId: box.id,
        };
      }

      emitInstallerEvent(
        onEvent,
        {
          step: "health",
          status: "succeeded",
          message: "Box install finished",
        },
        secrets,
      );

      return {
        ok: true,
        url,
        pairing: parsed.pairing?.code ? parsed.pairing : undefined,
        log: parsed.log,
        boxId: box.id,
      } satisfies InstallResult;
    },
    async close() {
      activeBoxId = undefined;
    },
  };
}
