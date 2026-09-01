import { createInterface } from "node:readline";
import { INSTALL_RELEASE, probeQuibtServicePort } from "@quibt/installer";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_ORIGIN = "http://127.0.0.1:3100";
const MAX_TRANSCRIPT_PAGE = 50;
const MAX_SEARCH_RESULTS = 20;
const ACTIVE_RUN_STATUSES = new Set(["queued", "leased", "running"]);
const ATTENTION_RUN_STATUSES = new Set(["waiting_input", "waiting_takeover"]);
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

type JsonObject = Record<string, unknown>;

export interface McpEnvironment {
  QUIBTBOT_URL?: string;
  QUIBTBOT_TOKEN?: string;
  ALLOW_INSECURE_HTTP?: string;
}

export interface McpDeps {
  fetch?: typeof fetch;
  env?: McpEnvironment;
  probePort?: (port: number) => Promise<boolean>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export interface McpIoDeps extends McpDeps {
  input?: NodeJS.ReadableStream;
  write?: (line: string) => void;
  error?: (line: string) => void;
}

export class McpConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConfigurationError";
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (!normalized.startsWith("127.")) return false;
  return normalized.split(".").every((part) => /^\d{1,3}$/.test(part));
}

function normalizeOrigin(raw: string, allowInsecureHttp: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new McpConfigurationError("QUIBTBOT_URL must be a valid http:// or https:// origin.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new McpConfigurationError("QUIBTBOT_URL must use http:// or https://.");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new McpConfigurationError(
      "QUIBTBOT_URL must be an origin without credentials, path, query, or fragment.",
    );
  }
  if (parsed.protocol === "http:" && !isLoopback(parsed.hostname) && !allowInsecureHttp) {
    throw new McpConfigurationError(
      "Refusing cleartext HTTP to a remote Quibt API. Use HTTPS or set ALLOW_INSECURE_HTTP=true.",
    );
  }
  return new URL(parsed.origin);
}

export async function resolveMcpConnection(deps: McpDeps = {}): Promise<{
  origin: string;
  token?: string;
}> {
  const env = deps.env ?? process.env;
  const configuredUrl = env.QUIBTBOT_URL?.trim();
  const configuredToken = env.QUIBTBOT_TOKEN?.trim();
  if (configuredToken && !configuredUrl) {
    throw new McpConfigurationError(
      "QUIBTBOT_TOKEN requires an explicit QUIBTBOT_URL; credentials are never sent during discovery.",
    );
  }

  const allowInsecureHttp = env.ALLOW_INSECURE_HTTP === "true";
  if (configuredUrl) {
    const url = normalizeOrigin(configuredUrl, allowInsecureHttp);
    return { origin: url.origin, token: configuredToken || undefined };
  }

  const fetchImpl = deps.fetch ?? fetch;
  const probe =
    deps.probePort ??
    ((port: number) =>
      probeQuibtServicePort(port, {
        fetch: fetchImpl,
      }));
  if (!(await probe(3100))) {
    throw new McpConfigurationError(
      "Quibt API was not found on http://127.0.0.1:3100. Start it or set QUIBTBOT_URL.",
    );
  }
  return { origin: DEFAULT_ORIGIN };
}

const SECRET_FIELD =
  /(?:authorization|cookie|password|passphrase|secret|token|api[_-]?key|credential|pairing|screenshot|pixels|data[_-]?url|screen[_-]?url)/i;
const PRIVILEGED_FIELD = /^(?:image|qr|autoApprove|alwaysAllow|allowKey|requestId)$/i;

/** Defense in depth: RPC projections already omit privileged surfaces; this strips them again. */
export function sanitizeMcpResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeMcpResult);
  if (!isObject(value)) {
    if (typeof value === "string" && /^data:image\//i.test(value)) return "[image stripped]";
    return value;
  }
  const clean: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELD.test(key) || PRIVILEGED_FIELD.test(key)) continue;
    clean[key] = sanitizeMcpResult(item);
  }
  return clean;
}

function safeBot(value: unknown): JsonObject {
  const bot = isObject(value) ? value : {};
  return sanitizeMcpResult({
    id: bot.id,
    name: bot.name,
    title: bot.title,
    description: bot.description,
    status: bot.status,
    preview: bot.preview,
    activeConversationId: bot.activeConversationId,
    updatedAt: bot.updatedAt,
  }) as JsonObject;
}

function safeGroup(value: unknown): JsonObject {
  const group = isObject(value) ? value : {};
  const members = Array.isArray(group.members)
    ? group.members.map((member) => {
        const row = isObject(member) ? member : {};
        return { id: row.id, name: row.name, title: row.title };
      })
    : [];
  return sanitizeMcpResult({
    id: group.id,
    name: group.name,
    members,
    preview: group.preview,
    updatedAt: group.updatedAt,
  }) as JsonObject;
}

function safeRun(value: unknown): JsonObject | null {
  if (!isObject(value)) return null;
  return sanitizeMcpResult({
    id: value.id,
    status: value.status,
    modelProvider: value.modelProvider,
    modelId: value.modelId,
    error: value.error,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
  }) as JsonObject;
}

function safeMessages(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((message) => {
    const row = isObject(message) ? message : {};
    return sanitizeMcpResult({
      id: row.id,
      seq: row.seq,
      role: row.role,
      blocks: row.blocks,
      runId: row.runId,
      fromBotId: row.fromBotId,
      authorBotId: row.authorBotId,
      createdAt: row.createdAt,
    });
  });
}

class QuibtRpcClient {
  private token?: string;

  constructor(
    private readonly origin: string,
    private readonly fetchImpl: typeof fetch,
    token?: string,
  ) {
    this.token = token;
  }

  async claimLocalSession(): Promise<void> {
    const url = new URL(this.origin);
    if (this.token || !isLoopback(url.hostname)) return;
    const response = await this.fetchImpl(`${this.origin}/api/local/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => ({}))) as JsonObject;
    if (!response.ok || typeof body.token !== "string" || !body.token) {
      throw new Error(
        typeof body.message === "string"
          ? body.message
          : `Could not create a local Quibt session (HTTP ${response.status}).`,
      );
    }
    this.token = body.token;
  }

  async call<T = unknown>(procedure: string, input: JsonObject = {}): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      origin: this.origin,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const response = await this.fetchImpl(`${this.origin}/rpc/${procedure}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ json: input }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json().catch(() => ({}))) as {
      json?: T | { message?: string };
      error?: { message?: string };
      message?: string;
    };
    if (!response.ok || body.error) {
      const nested = isObject(body.json) ? body.json : undefined;
      const message = body.error?.message ?? nested?.message ?? body.message;
      throw new Error(
        typeof message === "string"
          ? message
          : `Quibt RPC ${procedure} failed (${response.status}).`,
      );
    }
    return body.json as T;
  }
}

type ToolSchema = {
  name: string;
  description: string;
  inputSchema: JsonObject;
};

const objectSchema = (properties: JsonObject = {}, required: string[] = []): JsonObject => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const idSchema = { type: "string", minLength: 1 };
const textSchema = { type: "string", minLength: 1, maxLength: 20_000 };
const pageProperties = {
  before_seq: { type: "integer", minimum: 0 },
  limit: { type: "integer", minimum: 1, maximum: MAX_TRANSCRIPT_PAGE, default: 50 },
};

export const MCP_TOOLS: ToolSchema[] = [
  {
    name: "get_system_health",
    description: "Check the local Quibt API and worker health.",
    inputSchema: objectSchema(),
  },
  {
    name: "list_bots",
    description: "List bots in the current Quibt roster with their conversation status.",
    inputSchema: objectSchema(),
  },
  {
    name: "list_groups",
    description: "List Quibt groups and their bot members.",
    inputSchema: objectSchema(),
  },
  {
    name: "get_bot_messages",
    description: "Read one capped page of a bot transcript, newest page by default.",
    inputSchema: objectSchema({ bot_id: idSchema, ...pageProperties }, ["bot_id"]),
  },
  {
    name: "get_group_messages",
    description: "Read one capped page of a group transcript, newest page by default.",
    inputSchema: objectSchema({ group_id: idSchema, ...pageProperties }, ["group_id"]),
  },
  {
    name: "search_messages",
    description: "Search bot and group transcripts without reading settings or credentials.",
    inputSchema: objectSchema(
      {
        query: { type: "string", minLength: 2, maxLength: 100 },
        limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_RESULTS, default: 8 },
      },
      ["query"],
    ),
  },
  {
    name: "list_available_models",
    description: "List model catalog entries; credentials are never returned.",
    inputSchema: objectSchema(),
  },
  {
    name: "send_bot_message",
    description: "Send a message to one bot and start a run.",
    inputSchema: objectSchema({ bot_id: idSchema, text: textSchema }, ["bot_id", "text"]),
  },
  {
    name: "send_group_message",
    description: "Send a message to a group, optionally mentioning selected member bots.",
    inputSchema: objectSchema(
      {
        group_id: idSchema,
        text: textSchema,
        mention_bot_ids: { type: "array", items: idSchema, maxItems: 100 },
      },
      ["group_id", "text"],
    ),
  },
  {
    name: "wait_for_conversation",
    description:
      "Poll a bot or group run until it completes, fails, is cancelled, needs input/takeover, or times out.",
    inputSchema: {
      ...objectSchema({
        bot_id: idSchema,
        group_id: idSchema,
        run_id: idSchema,
        run_ids: { type: "array", items: idSchema, maxItems: 100 },
        timeout_ms: { type: "integer", minimum: 100, maximum: 120_000, default: 60_000 },
        poll_interval_ms: { type: "integer", minimum: 100, maximum: 5_000, default: 500 },
      }),
      oneOf: [{ required: ["bot_id"] }, { required: ["group_id"] }],
    },
  },
  {
    name: "interrupt_conversation",
    description: "Cancel active conversation runs for one bot or all members of one group.",
    inputSchema: {
      ...objectSchema({ bot_id: idSchema, group_id: idSchema }),
      oneOf: [{ required: ["bot_id"] }, { required: ["group_id"] }],
    },
  },
  {
    name: "set_bot_model",
    description:
      "Select the connected provider/model used for subsequent runs; refuses while the selected bot is busy.",
    inputSchema: objectSchema({ bot_id: idSchema, provider: idSchema, model_id: idSchema }, [
      "bot_id",
      "provider",
      "model_id",
    ]),
  },
];

const TOOL_BY_NAME = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));

function assertKnownFields(args: unknown, allowed: string[], required: string[] = []): JsonObject {
  if (!isObject(args)) throw new Error("Tool arguments must be an object.");
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`Unknown field(s): ${unknown.join(", ")}.`);
  const missing = required.filter((key) => !(key in args));
  if (missing.length) throw new Error(`Missing required field(s): ${missing.join(", ")}.`);
  return args;
}

function stringArg(
  args: JsonObject,
  name: string,
  options: { min?: number; max?: number } = {},
): string {
  const value = args[name];
  const min = options.min ?? 1;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new Error(`${name} must be a string between ${min} and ${max} characters.`);
  }
  return value;
}

function integerArg(
  args: JsonObject,
  name: string,
  fallback: number | undefined,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = args[name] ?? fallback;
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function pageInput(args: JsonObject, identity: "bot_id" | "group_id"): JsonObject {
  const input: JsonObject = {
    [identity === "bot_id" ? "botId" : "groupId"]: stringArg(args, identity),
    limit: integerArg(args, "limit", MAX_TRANSCRIPT_PAGE, 1, MAX_TRANSCRIPT_PAGE),
  };
  const before = integerArg(args, "before_seq", undefined, 0, Number.MAX_SAFE_INTEGER);
  if (before !== undefined) input.beforeSeq = before;
  return input;
}

export class McpControlPlane {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private client?: QuibtRpcClient;

  constructor(private readonly deps: McpDeps = {}) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.sleep =
      deps.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = deps.now ?? Date.now;
  }

  private async rpc(): Promise<QuibtRpcClient> {
    if (this.client) return this.client;
    const connection = await resolveMcpConnection({ ...this.deps, fetch: this.fetchImpl });
    const client = new QuibtRpcClient(connection.origin, this.fetchImpl, connection.token);
    await client.claimLocalSession();
    this.client = client;
    return client;
  }

  async callTool(name: string, rawArgs: unknown): Promise<unknown> {
    if (!TOOL_BY_NAME.has(name)) throw new Error(`Unknown tool: ${name}.`);
    const rpc = await this.rpc();
    switch (name) {
      case "get_system_health": {
        const args = assertKnownFields(rawArgs, []);
        void args;
        const health = await rpc.call<JsonObject>("health");
        return sanitizeMcpResult({
          ok: health.ok,
          version: health.version,
          edition: health.edition,
          worker: health.worker,
        });
      }
      case "list_bots": {
        assertKnownFields(rawArgs, []);
        const bots = await rpc.call<unknown[]>("bots/list");
        return Array.isArray(bots) ? bots.map(safeBot) : [];
      }
      case "list_groups": {
        assertKnownFields(rawArgs, []);
        const groups = await rpc.call<unknown[]>("botGroups/list");
        return Array.isArray(groups) ? groups.map(safeGroup) : [];
      }
      case "get_bot_messages": {
        const args = assertKnownFields(rawArgs, ["bot_id", "before_seq", "limit"], ["bot_id"]);
        const snapshot = await rpc.call<JsonObject>("threads/get", pageInput(args, "bot_id"));
        return sanitizeMcpResult({
          botId: snapshot.botId,
          cursor: snapshot.cursor,
          hasMore: snapshot.hasMore ?? false,
          messages: safeMessages(snapshot.messages),
          run: safeRun(snapshot.run),
          activeConversationId: snapshot.activeConversationId,
        });
      }
      case "get_group_messages": {
        const args = assertKnownFields(rawArgs, ["group_id", "before_seq", "limit"], ["group_id"]);
        const snapshot = await rpc.call<JsonObject>(
          "botGroups/thread",
          pageInput(args, "group_id"),
        );
        return sanitizeMcpResult({
          groupId: snapshot.groupId,
          cursor: snapshot.cursor,
          hasMore: snapshot.hasMore ?? false,
          messages: safeMessages(snapshot.messages),
          runs: Array.isArray(snapshot.runs) ? snapshot.runs.map(safeRun) : [],
        });
      }
      case "search_messages": {
        const args = assertKnownFields(rawArgs, ["query", "limit"], ["query"]);
        const results = await rpc.call<unknown[]>("threads/search", {
          query: stringArg(args, "query", { min: 2, max: 100 }),
          limit: integerArg(args, "limit", 8, 1, MAX_SEARCH_RESULTS),
        });
        return sanitizeMcpResult(results);
      }
      case "list_available_models": {
        assertKnownFields(rawArgs, []);
        const models = await rpc.call<unknown[]>("models/list");
        return sanitizeMcpResult(models);
      }
      case "send_bot_message": {
        const args = assertKnownFields(rawArgs, ["bot_id", "text"], ["bot_id", "text"]);
        return sanitizeMcpResult(
          await rpc.call("threads/send", {
            botId: stringArg(args, "bot_id"),
            text: stringArg(args, "text", { max: 20_000 }),
          }),
        );
      }
      case "send_group_message": {
        const args = assertKnownFields(
          rawArgs,
          ["group_id", "text", "mention_bot_ids"],
          ["group_id", "text"],
        );
        const mentionIds = args.mention_bot_ids;
        if (
          mentionIds !== undefined &&
          (!Array.isArray(mentionIds) ||
            mentionIds.length > 100 ||
            mentionIds.some((id) => typeof id !== "string" || !id))
        ) {
          throw new Error("mention_bot_ids must be an array of at most 100 non-empty strings.");
        }
        return sanitizeMcpResult(
          await rpc.call("botGroups/send", {
            groupId: stringArg(args, "group_id"),
            text: stringArg(args, "text", { max: 20_000 }),
            ...(mentionIds === undefined ? {} : { mentionBotIds: mentionIds }),
          }),
        );
      }
      case "wait_for_conversation": {
        const args = assertKnownFields(rawArgs, [
          "bot_id",
          "group_id",
          "run_id",
          "run_ids",
          "timeout_ms",
          "poll_interval_ms",
        ]);
        const botId = args.bot_id === undefined ? undefined : stringArg(args, "bot_id");
        const groupId = args.group_id === undefined ? undefined : stringArg(args, "group_id");
        if (Boolean(botId) === Boolean(groupId)) {
          throw new Error("Provide exactly one of bot_id or group_id.");
        }
        const runId = args.run_id === undefined ? undefined : stringArg(args, "run_id");
        const rawRunIds = args.run_ids;
        if (
          rawRunIds !== undefined &&
          (!Array.isArray(rawRunIds) ||
            rawRunIds.length > 100 ||
            rawRunIds.some((id) => typeof id !== "string" || !id))
        ) {
          throw new Error("run_ids must be an array of at most 100 non-empty strings.");
        }
        const runIds = rawRunIds as string[] | undefined;
        if (botId && runIds !== undefined) throw new Error("run_ids is only valid with group_id.");
        if (groupId && runId !== undefined) throw new Error("run_id is only valid with bot_id.");
        const timeout = integerArg(args, "timeout_ms", 60_000, 100, 120_000) ?? 60_000;
        const pollInterval = integerArg(args, "poll_interval_ms", 500, 100, 5_000) ?? 500;
        const deadline = this.now() + timeout;
        let observed = false;
        while (true) {
          const snapshot = botId
            ? await rpc.call<JsonObject>("threads/get", { botId, limit: 20 })
            : await rpc.call<JsonObject>("botGroups/thread", { groupId, limit: 20 });
          const snapshotRuns = botId
            ? isObject(snapshot.run)
              ? [snapshot.run]
              : []
            : Array.isArray(snapshot.runs)
              ? snapshot.runs.filter(isObject)
              : [];
          const matchingRuns = snapshotRuns.filter((run) => {
            if (runId) return run.id === runId;
            if (runIds) return typeof run.id === "string" && runIds.includes(run.id);
            return true;
          });
          if (matchingRuns.length) {
            observed = true;
            const attention = matchingRuns.find(
              (run) => typeof run.status === "string" && ATTENTION_RUN_STATUSES.has(run.status),
            );
            const terminal = matchingRuns.find(
              (run) => typeof run.status === "string" && TERMINAL_RUN_STATUSES.has(run.status),
            );
            if (attention || terminal) {
              const decisive = attention ?? terminal;
              return sanitizeMcpResult({
                status: decisive?.status,
                runs: matchingRuns.map(safeRun),
                messages: safeMessages(snapshot.messages),
              });
            }
            const unexpected = matchingRuns.find(
              (run) => typeof run.status === "string" && !ACTIVE_RUN_STATUSES.has(run.status),
            );
            if (unexpected) {
              return sanitizeMcpResult({
                status: unexpected.status,
                runs: matchingRuns.map(safeRun),
                messages: safeMessages(snapshot.messages),
              });
            }
          } else if (observed || runId || runIds) {
            return sanitizeMcpResult({
              status: "completed",
              runId,
              runIds,
              messages: safeMessages(snapshot.messages),
            });
          } else if (snapshotRuns.length === 0 && !runId && !runIds) {
            return sanitizeMcpResult({ status: "idle", messages: safeMessages(snapshot.messages) });
          }
          if (this.now() >= deadline) {
            return sanitizeMcpResult({
              status: "timeout",
              runs: matchingRuns.map(safeRun),
              messages: safeMessages(snapshot.messages),
            });
          }
          await this.sleep(Math.min(pollInterval, Math.max(0, deadline - this.now())));
        }
        return { status: "timeout" };
      }
      case "interrupt_conversation": {
        const args = assertKnownFields(rawArgs, ["bot_id", "group_id"]);
        const botId = args.bot_id === undefined ? undefined : stringArg(args, "bot_id");
        const groupId = args.group_id === undefined ? undefined : stringArg(args, "group_id");
        if (Boolean(botId) === Boolean(groupId)) {
          throw new Error("Provide exactly one of bot_id or group_id.");
        }
        if (botId) {
          return sanitizeMcpResult(await rpc.call("threads/stop", { botId }));
        }
        const group = await rpc.call<JsonObject>("botGroups/get", { groupId });
        const memberIds = Array.isArray(group.members)
          ? group.members.flatMap((member) =>
              isObject(member) && typeof member.id === "string" ? [member.id] : [],
            )
          : [];
        const stopped = await Promise.all(
          memberIds.map((memberBotId) => rpc.call("threads/stop", { botId: memberBotId })),
        );
        return sanitizeMcpResult({ ok: true, groupId, stopped: stopped.length });
      }
      case "set_bot_model": {
        const args = assertKnownFields(
          rawArgs,
          ["bot_id", "provider", "model_id"],
          ["bot_id", "provider", "model_id"],
        );
        const botId = stringArg(args, "bot_id");
        const snapshot = await rpc.call<JsonObject>("threads/get", { botId, limit: 1 });
        const run = isObject(snapshot.run) ? snapshot.run : null;
        const status = typeof run?.status === "string" ? run.status : undefined;
        if (status && (ACTIVE_RUN_STATUSES.has(status) || ATTENTION_RUN_STATUSES.has(status))) {
          throw new Error(
            `Bot ${botId} is busy (${status}); interrupt or wait before changing its model.`,
          );
        }
        await rpc.call("models/setDefault", {
          provider: stringArg(args, "provider"),
          modelId: stringArg(args, "model_id"),
        });
        return { ok: true, botId, provider: args.provider, modelId: args.model_id };
      }
      default:
        throw new Error(`Unknown tool: ${name}.`);
    }
  }
}

type JsonRpcId = string | number | null;

function jsonRpcError(id: JsonRpcId, code: number, message: string): JsonObject {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function jsonRpcResult(id: JsonRpcId, result: unknown): JsonObject {
  return { jsonrpc: "2.0", id, result };
}

export async function handleMcpMessage(
  controlPlane: McpControlPlane,
  request: unknown,
): Promise<JsonObject | null> {
  if (!isObject(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return jsonRpcError(null, -32600, "Invalid Request");
  }
  const id =
    typeof request.id === "string" || typeof request.id === "number" || request.id === null
      ? request.id
      : null;
  const notification = !("id" in request);
  if (
    request.method === "notifications/initialized" ||
    request.method === "notifications/cancelled"
  ) {
    return null;
  }
  if (notification) return null;

  if (request.method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "quibtbot", version: INSTALL_RELEASE },
      instructions:
        "Drive the existing Quibt roster. This server deliberately excludes credentials, approvals, deletion, pairing, settings, and computer lifecycle tools.",
    });
  }
  if (request.method === "ping") return jsonRpcResult(id, {});
  if (request.method === "tools/list") {
    const params = request.params ?? {};
    if (!isObject(params) || Object.keys(params).length > 0) {
      return jsonRpcError(id, -32602, "tools/list does not accept parameters.");
    }
    return jsonRpcResult(id, { tools: MCP_TOOLS });
  }
  if (request.method === "tools/call") {
    const params = request.params;
    if (!isObject(params)) return jsonRpcError(id, -32602, "tools/call params must be an object.");
    const unknownParams = Object.keys(params).filter(
      (key) => key !== "name" && key !== "arguments",
    );
    if (unknownParams.length) {
      return jsonRpcError(id, -32602, `Unknown tools/call field(s): ${unknownParams.join(", ")}.`);
    }
    if (typeof params.name !== "string" || !TOOL_BY_NAME.has(params.name)) {
      return jsonRpcError(id, -32602, `Unknown tool: ${String(params.name)}.`);
    }
    try {
      const result = await controlPlane.callTool(params.name, params.arguments ?? {});
      const text = JSON.stringify(result);
      return jsonRpcResult(id, {
        content: [{ type: "text", text }],
        structuredContent: { result },
      });
    } catch (error) {
      return jsonRpcResult(id, {
        content: [
          { type: "text", text: error instanceof Error ? error.message : "Quibt tool failed." },
        ],
        isError: true,
      });
    }
  }
  return jsonRpcError(id, -32601, "Method not found");
}

export async function runMcpServer(deps: McpIoDeps = {}): Promise<void> {
  const input = deps.input ?? process.stdin;
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const error = deps.error ?? ((line: string) => process.stderr.write(`${line}\n`));
  const controlPlane = new McpControlPlane(deps);
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      write(JSON.stringify(jsonRpcError(null, -32700, "Parse error")));
      continue;
    }
    try {
      const response = await handleMcpMessage(controlPlane, request);
      if (response) write(JSON.stringify(response));
    } catch (caught) {
      error(caught instanceof Error ? caught.message : "Unexpected MCP server error.");
      const requestId = isObject(request) ? request.id : null;
      const id = typeof requestId === "string" || typeof requestId === "number" ? requestId : null;
      write(JSON.stringify(jsonRpcError(id, -32603, "Internal error")));
    }
  }
}
