import type {
  AdapterContext,
  CommandRequest,
  ComputerInput,
  ComputerRef,
  ControlLeaseRef,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
} from "@quibt/adapter-kit";
import { boundedSandboxCommandTimeoutMs } from "@quibt/core";

export const BOX_API_BASE_URL = "https://ascii.dev/api/box/v1";

/** Box command timeout cap per the v1 API (`timeoutSeconds` is 1-600). */
export const BOX_COMMAND_TIMEOUT_SECONDS = 600;

const READY_STATES = new Set(["ready", "idle", "running"]);
const DEFAULT_PROVISION_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface BoxInfo {
  id: string;
  name?: string;
  state: string;
  url?: string | null;
  ip?: string | null;
  desktopAvailable?: boolean;
  desktopUrl?: string | null;
  snapshotAvailable?: boolean;
  archiveAfter?: string | null;
}

export interface BoxSandboxOptions {
  baseUrl?: string;
  pollIntervalMs?: number;
  provisionTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export function isUnrecoverableBoxError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|does not exist|404|not_found|archived permanently/i.test(message);
}

/**
 * Turn the executor's argv into the single shell command string the Box API
 * expects. The executor always calls with ["bash", "-lc", command]; unwrap that
 * form instead of joining so the inner command keeps its quoting. Anything else
 * is shell-quoted element by element.
 */
export function boxCommandFromArgv(argv: string[]): string {
  if (
    argv.length === 3 &&
    (argv[0] === "bash" || argv[0] === "sh") &&
    (argv[1] === "-lc" || argv[1] === "-c") &&
    typeof argv[2] === "string"
  ) {
    return argv[2];
  }
  return argv.map(shellQuote).join(" ");
}

export function shellQuote(part: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(part)) return part;
  return `'${part.replace(/'/g, "'\\''")}'`;
}

/**
 * Cloud computer provider backed by Box (box.ascii.dev). Talks the public REST
 * API (https://docs.ascii.dev/openapi/box-v1.yaml) with native fetch — the
 * surface we need is six endpoints, so the SDK would only add a dependency.
 * Boxes are created per bot with `ttlSeconds: null` (no auto-stop) and
 * `noEnv: true` (never inherit operator credentials); the
 * platform's own idle scheduler decides when to stop them, and a stop archives
 * the disk so resume restores the same machine state.
 */
export class BoxSandboxProvider implements SandboxProvider {
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly provisionTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly screenUrls = new Map<string, string>();

  constructor(
    private readonly apiKey: string,
    options: BoxSandboxOptions = {},
  ) {
    this.baseUrl = (options.baseUrl ?? BOX_API_BASE_URL).replace(/\/$/, "");
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.provisionTimeoutMs = options.provisionTimeoutMs ?? DEFAULT_PROVISION_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  describe() {
    return {
      id: "box",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        // Box v1 exposes a human noVNC URL but no agent input-injection API.
        agentInput: false,
        pty: true,
        snapshots: true,
        takeover: true,
        persistentHome: true,
      },
    };
  }

  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    const deadline = AbortSignal.timeout(options.timeoutMs ?? this.requestTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`box api ${method} ${path} failed: ${res.status} ${redact(detail)}`.trim());
    }
    return (await res.json()) as T;
  }

  private async getBox(boxId: string, signal?: AbortSignal): Promise<BoxInfo> {
    const body = await this.request<{ box: BoxInfo }>("GET", `/boxes/${boxId}`, { signal });
    return body.box;
  }

  private async waitUntilReady(boxId: string, signal?: AbortSignal): Promise<BoxInfo> {
    const startedAt = Date.now();
    for (;;) {
      const box = await this.getBox(boxId, signal);
      if (READY_STATES.has(box.state)) return box;
      if (box.state === "error") throw new Error(`box ${boxId} entered error state`);
      if (box.state === "archived") {
        await this.request("POST", `/boxes/${boxId}/resume`, { body: {}, signal });
      }
      if (Date.now() - startedAt > this.provisionTimeoutMs) {
        throw new Error(`box ${boxId} did not become ready in time (state: ${box.state})`);
      }
      await sleep(this.pollIntervalMs, signal);
    }
  }

  private async desktopUrl(boxId: string, signal?: AbortSignal): Promise<string | null> {
    // POST /boxes/{boxId}/desktop?vnc=1 returns a secret-bearing noVNC URL.
    // While `provisioning: true` the desktop is still being prepared; poll.
    const startedAt = Date.now();
    for (;;) {
      const body = await this.request<{
        desktopUrl?: string | null;
        provisioning?: boolean;
      }>("POST", `/boxes/${boxId}/desktop?vnc=1`, { body: {}, signal });
      if (body.desktopUrl) return body.desktopUrl;
      if (!body.provisioning) return null;
      if (Date.now() - startedAt > this.provisionTimeoutMs) return null;
      await sleep(this.pollIntervalMs, signal);
    }
  }

  async provision(
    request: { botId: string; homePath: string; providerRef?: string; display?: number },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    if (request.providerRef) {
      try {
        const box = await this.waitUntilReady(request.providerRef, context.signal);
        return this.toRef(box, request.botId, context);
      } catch (error) {
        this.screenUrls.delete(request.providerRef);
        if (!isUnrecoverableBoxError(error)) throw error;
      }
    }
    const created = await this.request<{ box: BoxInfo }>("POST", "/boxes", {
      // Persistent per-bot computer: null disables auto-stop entirely; our own
      // idle scheduler (computer.sleep) stops the box when the bot goes quiet.
      body: { ttlSeconds: null, noEnv: true },
      signal: context.signal,
    });
    const box = await this.waitUntilReady(created.box.id, context.signal);
    return this.toRef(box, request.botId, context);
  }

  private async toRef(box: BoxInfo, botId: string, context: AdapterContext): Promise<ComputerRef> {
    let screenUrl = box.desktopUrl ?? this.screenUrls.get(box.id);
    if (!screenUrl) {
      screenUrl = (await this.desktopUrl(box.id, context.signal).catch(() => null)) ?? undefined;
    }
    if (screenUrl) this.screenUrls.set(box.id, screenUrl);
    return {
      id: box.id,
      botId,
      kind: "box",
      providerRef: box.id,
      ...(screenUrl ? { screenUrl } : {}),
    };
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const boxId = computer.providerRef || computer.id;
    let command = boxCommandFromArgv(request.argv);
    // ASSUMPTION: the API documents `cwd` as relative to the Box work
    // directory, but our callers pass absolute paths (e.g. /home/user), so we
    // `cd` inside the command instead of sending `cwd`.
    if (request.cwd) command = `cd ${shellQuote(request.cwd)} && ${command}`;
    try {
      const result = await this.request<{
        exitCode: number | null;
        stdout: string;
        stderr: string;
        timedOut: boolean;
      }>("POST", `/boxes/${boxId}/commands`, {
        body: {
          command,
          timeoutSeconds: Math.min(
            BOX_COMMAND_TIMEOUT_SECONDS,
            Math.ceil(boundedSandboxCommandTimeoutMs(request.timeoutMs) / 1000),
          ),
        },
        signal: context.signal,
        timeoutMs: boundedSandboxCommandTimeoutMs(request.timeoutMs) + 10_000,
      });
      if (result.stdout) yield { type: "stdout", data: result.stdout };
      if (result.stderr) yield { type: "stderr", data: result.stderr };
      if (result.timedOut) yield { type: "stderr", data: "command timed out\n" };
      yield { type: "exit", code: result.exitCode ?? (result.timedOut ? 124 : 0) };
    } catch (error) {
      yield { type: "stderr", data: `${error instanceof Error ? error.message : error}\n` };
      yield { type: "exit", code: 1 };
    }
  }

  async connectScreen(
    computer: ComputerRef,
    _request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    const boxId = computer.providerRef || computer.id;
    const url = await this.desktopUrl(boxId, context.signal).catch(() => null);
    if (url) this.screenUrls.set(boxId, url);
    return {
      url: url ?? computer.screenUrl ?? null,
      mimeType: "text/html",
      close: async () => undefined,
    };
  }

  async sendInput(
    _computer: ComputerRef,
    _input: ComputerInput,
    _lease: ControlLeaseRef,
    _context: AdapterContext,
  ): Promise<void> {
    // The Box v1 API has no input-injection endpoint. Takeover happens through
    // the interactive noVNC desktop URL itself, which carries mouse/keyboard.
  }

  async snapshot(computer: ComputerRef, context: AdapterContext) {
    const boxId = computer.providerRef || computer.id;
    const body = await this.request<{
      snapshot: { id: string; completedAt?: string | null; createdAt?: string | null } | null;
    }>("GET", `/boxes/${boxId}/snapshots/latest`, { signal: context.signal }).catch(() => null);
    const snapshot = body?.snapshot;
    if (snapshot) {
      return {
        id: snapshot.id,
        createdAt: snapshot.completedAt ?? snapshot.createdAt ?? new Date().toISOString(),
      };
    }
    return { id: `box-${boxId}-${Date.now()}`, createdAt: new Date().toISOString() };
  }

  async keepAlive(computer: ComputerRef): Promise<void> {
    // Boxes are created with auto-stop disabled, so keepAlive only needs to
    // resurrect a box that was archived (e.g. stopped by our idle scheduler).
    const boxId = computer.providerRef || computer.id;
    const box = await this.getBox(boxId);
    if (box?.state === "archived") {
      await this.request("POST", `/boxes/${boxId}/resume`, { body: {} });
    }
  }

  async stop(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const boxId = computer.providerRef || computer.id;
    this.screenUrls.delete(boxId);
    // Stop archives the box: the disk is snapshotted first, so a later resume
    // restores the exact machine state. Never pass `force` here — losing work
    // is worse than a box that keeps running one more cycle.
    await this.request("POST", `/boxes/${boxId}/stop`, {
      body: {},
      signal: context.signal,
    });
  }

  async destroy(computer: ComputerRef, context: AdapterContext): Promise<void> {
    // ASSUMPTION: the Box v1 API has no delete endpoint (verified against the
    // OpenAPI spec) — lifecycle ends at stop/archive, so destroy archives.
    await this.stop(computer, context);
  }
}

function redact(text: string): string {
  return text.replace(/(_token|token|key)=[^&\s"']+/gi, "$1=redacted").slice(0, 500);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
