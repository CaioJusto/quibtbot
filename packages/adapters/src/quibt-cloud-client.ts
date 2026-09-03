/**
 * Isolated HTTP client for the Quibt Bot Cloud SaaS API.
 *
 * REVIEW: every path and response shape here is a **working hypothesis**.
 * When the real Cloud contract is confirmed, change this file (and the
 * parsers below) — callers should not issue raw Cloud HTTP themselves.
 */

import {
  type QuibtCloudBox,
  type QuibtCloudBoxStatus,
  type QuibtCloudConnection,
  type QuibtCloudLimit,
  type QuibtCloudLimitKind,
  type QuibtCloudMe,
  quibtCloudCanResume,
  quibtCloudLimitFromKind,
  resolveQuibtCloudApiUrl,
} from "@quibt/core";

export const QUIBT_CLOUD_CONTRACT_REVIEW =
  "Hypothesized Quibt Bot Cloud API — confirm paths and field names against the real backend.";

export class QuibtCloudApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(`quibt-cloud ${method} ${path} failed: ${status}${code ? ` ${code}` : ""}`);
    this.name = "QuibtCloudApiError";
  }
}

export class QuibtCloudLimitError extends Error {
  readonly limit: QuibtCloudLimit;

  constructor(limit: QuibtCloudLimit) {
    super(limit.upgradeMessage);
    this.name = "QuibtCloudLimitError";
    this.limit = limit;
  }
}

export interface QuibtCloudLoginResult {
  token: string;
}

/** Seam for tests and for swapping the hypothesized transport later. */
export interface QuibtCloudClient {
  readonly baseUrl: string;
  setToken(token: string | null): void;
  getToken(): string | null;
  login(email: string, password: string): Promise<QuibtCloudLoginResult>;
  me(): Promise<QuibtCloudMe>;
  listBoxes(): Promise<QuibtCloudBox[]>;
  resumeBox(boxId: string): Promise<QuibtCloudBox>;
  stopBox(boxId: string): Promise<QuibtCloudBox>;
  getConnection(boxId: string): Promise<QuibtCloudConnection>;
  /**
   * REVIEW: optional hypothesized extension — not in the documented Cloud
   * contract (login / me / boxes / resume / stop / connection).
   */
  runCommand?(
    boxId: string,
    command: string,
    timeoutSeconds: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface QuibtCloudClientOptions {
  baseUrl?: string;
  token?: string | null;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export function createQuibtCloudClient(
  options: QuibtCloudClientOptions = {},
): QuibtCloudHttpClient {
  return new QuibtCloudHttpClient(options);
}

export class QuibtCloudHttpClient implements QuibtCloudClient {
  readonly baseUrl: string;
  private token: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: QuibtCloudClientOptions = {}) {
    this.baseUrl = resolveQuibtCloudApiUrl({ override: options.baseUrl });
    this.token = options.token?.trim() || null;
    // Bind global fetch: assigning `fetch` and calling it as `this.fetchImpl(...)` loses
    // `Window`/`globalThis` and throws "Illegal invocation" in browsers.
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  setToken(token: string | null): void {
    this.token = token?.trim() || null;
  }

  getToken(): string | null {
    return this.token;
  }

  async login(email: string, password: string): Promise<QuibtCloudLoginResult> {
    const body = await this.request<unknown>("POST", "/api/auth/login", {
      body: { email, password },
      auth: false,
    });
    const token = readSessionToken(body);
    if (!token) {
      throw new QuibtCloudApiError("POST", "/api/auth/login", 200, "missing_token");
    }
    this.token = token;
    return { token };
  }

  async me(): Promise<QuibtCloudMe> {
    const body = await this.request<unknown>("GET", "/api/me");
    return parseQuibtCloudMe(body);
  }

  async listBoxes(): Promise<QuibtCloudBox[]> {
    const body = await this.request<unknown>("GET", "/api/boxes");
    return parseQuibtCloudBoxes(body);
  }

  async resumeBox(boxId: string): Promise<QuibtCloudBox> {
    const id = encodeURIComponent(boxId);
    const body = await this.request<unknown>("POST", `/api/boxes/${id}/resume`, { body: {} });
    return parseQuibtCloudBox(body, boxId);
  }

  async stopBox(boxId: string): Promise<QuibtCloudBox> {
    const id = encodeURIComponent(boxId);
    const body = await this.request<unknown>("POST", `/api/boxes/${id}/stop`, { body: {} });
    return parseQuibtCloudBox(body, boxId, "stopped");
  }

  async getConnection(boxId: string): Promise<QuibtCloudConnection> {
    const id = encodeURIComponent(boxId);
    const body = await this.request<unknown>("GET", `/api/boxes/${id}/connection`);
    return parseQuibtCloudConnection(body);
  }

  /** REVIEW: optional hypothesized extension. */
  async runCommand(
    boxId: string,
    command: string,
    timeoutSeconds: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const id = encodeURIComponent(boxId);
    const body = await this.request<{
      stdout?: string;
      stderr?: string;
      exitCode?: number | null;
    }>("POST", `/api/boxes/${id}/commands`, {
      body: { command, timeoutSeconds },
    });
    return {
      stdout: body.stdout ?? "",
      stderr: body.stderr ?? "",
      exitCode: body.exitCode ?? 0,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; auth?: boolean; signal?: AbortSignal } = {},
  ): Promise<T> {
    const deadline = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.auth !== false && this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal,
    });
    const detail = await res.text().catch(() => "");
    if (!res.ok) {
      const code = cloudErrorCode(detail);
      const limit = limitFromCloudError(res.status, code, detail);
      if (limit) throw new QuibtCloudLimitError(limit);
      throw new QuibtCloudApiError(method, path, res.status, code);
    }
    if (!detail) return {} as T;
    try {
      return JSON.parse(detail) as T;
    } catch {
      throw new QuibtCloudApiError(method, path, res.status, "invalid_json");
    }
  }
}

export interface QuibtCloudSessionSnapshot {
  token: string | null;
  me: QuibtCloudMe | null;
  boxes: QuibtCloudBox[];
  limit: QuibtCloudLimit | null;
}

/**
 * Login + usage reflection + start/stop gating. UI and the sandbox provider
 * share this so quota checks never scatter across fetch calls.
 */
export class QuibtCloudSession {
  private meState: QuibtCloudMe | null = null;
  private boxesState: QuibtCloudBox[] = [];

  constructor(private readonly client: QuibtCloudClient) {}

  snapshot(): QuibtCloudSessionSnapshot {
    return this.current();
  }

  async login(email: string, password: string): Promise<QuibtCloudSessionSnapshot> {
    await this.client.login(email, password);
    return this.refresh();
  }

  async refresh(): Promise<QuibtCloudSessionSnapshot> {
    const [me, boxes] = await Promise.all([this.client.me(), this.client.listBoxes()]);
    this.meState = me;
    this.boxesState = boxes;
    return this.current();
  }

  async resume(boxId: string): Promise<QuibtCloudSessionSnapshot> {
    const me = this.meState ?? (await this.client.me());
    this.meState = me;
    const existing = this.boxesState.find((box) => box.id === boxId);
    const decision = quibtCloudCanResume(me, existing);
    if (!decision.ok) throw new QuibtCloudLimitError(decision.limit);
    const box = await this.client.resumeBox(boxId);
    this.upsertBox(box);
    try {
      this.meState = await this.client.me();
    } catch {
      // Keep the last known plan if /me fails after a successful resume.
    }
    return this.current();
  }

  async stop(boxId: string): Promise<QuibtCloudSessionSnapshot> {
    const box = await this.client.stopBox(boxId);
    this.upsertBox(box);
    try {
      this.meState = await this.client.me();
    } catch {
      // Same as resume: a stop that landed should still update the list.
    }
    return this.current();
  }

  async connection(boxId: string): Promise<QuibtCloudConnection> {
    return this.client.getConnection(boxId);
  }

  private upsertBox(box: QuibtCloudBox): void {
    const next = this.boxesState.filter((entry) => entry.id !== box.id);
    next.push(box);
    this.boxesState = next;
  }

  private current(): QuibtCloudSessionSnapshot {
    const limit = this.meState
      ? (() => {
          const decision = quibtCloudCanResume(this.meState);
          return decision.ok ? null : decision.limit;
        })()
      : null;
    return {
      token: this.client.getToken(),
      me: this.meState,
      boxes: this.boxesState,
      limit,
    };
  }
}

export function isQuibtCloudLimitError(error: unknown): error is QuibtCloudLimitError {
  return error instanceof QuibtCloudLimitError;
}

export function parseQuibtCloudMe(body: unknown): QuibtCloudMe {
  const root = unwrap(body, ["me", "account", "user"]);
  const planRaw = pick(root, ["plan", "currentPlan"]) ?? pick(body, ["plan"]);
  const plan =
    typeof planRaw === "string"
      ? { id: planRaw, name: planRaw }
      : {
          id: stringField(planRaw, ["id", "slug", "code"], "plan"),
          name: stringField(planRaw, ["name", "title", "label"], "Plan"),
        };
  return {
    email: optionalString(root, ["email"]) ?? optionalString(body, ["email"]),
    plan,
    hoursUsed: numberField(root, ["hoursUsed", "hours_used", "hoursEquivalentUsed", "hoursEqUsed"]),
    hoursQuota: numberField(root, [
      "hoursQuota",
      "hours_quota",
      "hoursCap",
      "hoursLimit",
      "hoursEqQuota",
    ]),
    concurrentComputers: numberField(root, [
      "concurrentComputers",
      "concurrent_computers",
      "runningComputers",
      "runningBoxes",
    ]),
    concurrentLimit: numberField(root, [
      "concurrentLimit",
      "concurrent_limit",
      "maxComputers",
      "maxConcurrentComputers",
    ]),
  };
}

export function parseQuibtCloudBoxes(body: unknown): QuibtCloudBox[] {
  const list = Array.isArray(body)
    ? body
    : ((pick(body, ["boxes", "items", "data"]) as unknown[] | undefined) ?? []);
  return list
    .map((entry) => parseQuibtCloudBox(entry))
    .filter((box): box is QuibtCloudBox => Boolean(box.id));
}

export function parseQuibtCloudBox(
  body: unknown,
  fallbackId = "",
  fallbackStatus: QuibtCloudBoxStatus = "stopped",
): QuibtCloudBox {
  const root = unwrap(body, ["box"]);
  const id = stringField(root, ["id", "boxId"], fallbackId);
  const raw = stringField(root, ["status", "state"], fallbackStatus).toLowerCase();
  const status: QuibtCloudBoxStatus =
    raw === "running" || raw === "ready" || raw === "idle" ? "running" : "stopped";
  return { id, status };
}

export function parseQuibtCloudConnection(body: unknown): QuibtCloudConnection {
  const root = unwrap(body, ["connection", "access"]);
  const port = numberField(root, ["port"]);
  const protocolRaw = optionalString(root, ["protocol"])?.toLowerCase();
  const protocol =
    protocolRaw === "ssh" || protocolRaw === "vnc" || protocolRaw === "novnc"
      ? protocolRaw
      : undefined;
  return {
    host: stringField(root, ["host", "hostname", "address"]),
    port,
    protocol,
    username: optionalString(root, ["username", "user"]),
    credential: optionalString(root, ["credential", "password", "token"]),
    screenUrl: optionalString(root, ["screenUrl", "desktopUrl", "url"]),
    path: optionalString(root, ["path"]),
  };
}

export function readSessionToken(body: unknown): string | null {
  const root = unwrap(body, ["session", "auth", "data"]);
  return (
    optionalString(root, ["token", "sessionToken", "accessToken", "access_token"]) ??
    optionalString(body, ["token", "sessionToken", "accessToken", "access_token"]) ??
    null
  );
}

function limitFromCloudError(
  status: number,
  code: string | undefined,
  detail: string,
): QuibtCloudLimit | null {
  const kind = limitKindFromCode(code) ?? limitKindFromStatus(status, detail);
  return kind ? quibtCloudLimitFromKind(kind) : null;
}

function limitKindFromCode(code: string | undefined): QuibtCloudLimitKind | null {
  if (!code) return null;
  if (/hour|quota|usage/i.test(code)) return "hours";
  if (/concurrent|limit|capacity/i.test(code)) return "concurrent";
  return null;
}

function limitKindFromStatus(status: number, detail: string): QuibtCloudLimitKind | null {
  if (status !== 402 && status !== 403 && status !== 429) return null;
  if (/hour|hora|quota/i.test(detail)) return "hours";
  if (/concurrent|simult/i.test(detail)) return "concurrent";
  if (status === 402) return "hours";
  return "concurrent";
}

function cloudErrorCode(detail: string): string | undefined {
  try {
    const body = JSON.parse(detail) as { code?: unknown; error?: { code?: unknown } | unknown };
    const nested =
      typeof body.error === "object" && body.error !== null
        ? (body.error as { code?: unknown }).code
        : undefined;
    const code = body.code ?? nested;
    return typeof code === "string" && /^[a-z0-9._-]{1,80}$/i.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

function unwrap(body: unknown, keys: string[]): Record<string, unknown> {
  if (!isRecord(body)) return {};
  for (const key of keys) {
    const inner = body[key];
    if (isRecord(inner)) return inner;
  }
  return body;
}

function pick(body: unknown, keys: string[]): unknown {
  if (!isRecord(body)) return undefined;
  for (const key of keys) {
    if (body[key] !== undefined) return body[key];
  }
  return undefined;
}

function stringField(body: unknown, keys: string[], fallback = ""): string {
  const value = optionalString(body, keys);
  return value ?? fallback;
}

function optionalString(body: unknown, keys: string[]): string | undefined {
  const value = pick(body, keys);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(body: unknown, keys: string[]): number {
  const value = pick(body, keys);
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
