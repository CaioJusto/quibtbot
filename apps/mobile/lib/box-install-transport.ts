import type { InstallerEvent } from "@quibt/installer";
import {
  BOX_API_BASE_URL,
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

export function isValidBoxId(boxId: string): boolean {
  return BOX_ID_PATTERN.test(boxId);
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
    throw new Error(`Box API ${method} ${path} failed (${response.status})`);
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
    if (!isServerBoxRecord(body.box)) {
      throw new Error("The selected Box is not a Quibt server VM.");
    }
    if (["ready", "idle", "running"].includes(body.box.state)) return body.box;
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
  onAllocated?: (id: string) => void,
): Promise<string> {
  if (boxId) {
    if (!isValidBoxId(boxId)) throw new Error("Invalid Box server id.");
    onAllocated?.(boxId);
    return boxId;
  }

  const listed = await boxRequest<{ boxes: BoxRecord[] }>(loadApiKey, "GET", "/boxes", {
    fetchImpl,
    signal,
  });
  const existing = listed.boxes.find((box) => isServerBoxRecord(box));
  if (existing) {
    onAllocated?.(existing.id);
    return existing.id;
  }

  const created = await boxRequest<{ box: BoxRecord }>(loadApiKey, "POST", "/boxes", {
    body: createServerBoxRequest(),
    fetchImpl,
    signal,
  });
  onAllocated?.(created.box.id);
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
  onBoxAllocated?: (boxId: string) => void;
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
