import { Composio } from "@composio/core";
import type {
  AdapterContext,
  ConnectionAuthProvider,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorTool,
} from "@quibt/adapter-kit";
import {
  composioToolkitDirectory,
  mergeCatalogWithConnected,
  type ToolkitDirectoryEntry,
} from "./composio-catalog-cache.js";
import { DestinationEmulator } from "./destination-emulator.js";

type ComposioSession = Awaited<ReturnType<Composio["create"]>>;

export function isComposioEnabled(apiKey: string | undefined): boolean {
  return Boolean(apiKey) && !process.env.VITEST;
}

/** Thrown when neither the env nor the deployment settings hold a Composio key. */
export class ComposioKeyMissingError extends Error {
  constructor() {
    super("Cole a chave da sua conta Composio em Plugins para ligar os apps.");
    this.name = "ComposioKeyMissingError";
  }
}

export interface ComposioConnectorOptions {
  /** Tests pass a fake SDK. */
  client?: Composio;
  /** Set at boot from COMPOSIO_API_KEY. */
  envApiKey?: string;
  /**
   * The key the deployment owner pasted in the app (BYOK). Read on demand so a
   * key saved after boot — or removed — takes effect without a restart.
   */
  loadStoredKey?: () => Promise<string | undefined>;
}

/** How long a stored-key lookup is trusted before asking the store again. */
export const COMPOSIO_KEY_TTL_MS = 15_000;

/**
 * How long `complete()` waits for the connected account to go active. Short,
 * because the web and mobile callbacks poll instead of holding one request
 * open for the SDK's 60s default.
 */
const COMPLETE_WAIT_MS = 3_000;

export function asConnectorTools(input: unknown): ConnectorTool[] {
  const items = Array.isArray(input)
    ? input
    : input && typeof input === "object" && Array.isArray((input as { items?: unknown }).items)
      ? ((input as { items: unknown[] }).items ?? [])
      : [];
  const tools: ConnectorTool[] = [];
  for (const item of items) {
    const mapped = mapOneTool(item);
    if (mapped) tools.push(mapped);
  }
  return tools;
}

function mapOneTool(item: unknown): ConnectorTool | undefined {
  if (!item || typeof item !== "object") return undefined;
  const raw = item as Record<string, unknown>;
  if (raw.type === "function" && raw.function && typeof raw.function === "object") {
    const fn = raw.function as Record<string, unknown>;
    const name = String(fn.name ?? "");
    if (!name) return undefined;
    return {
      name,
      description: String(fn.description ?? name),
      inputSchema: asObject(fn.parameters) ?? { type: "object", properties: {} },
    };
  }
  const name = String(raw.slug ?? raw.name ?? "");
  if (!name) return undefined;
  return {
    name,
    description: String(raw.description ?? name),
    inputSchema: asObject(raw.inputParameters) ??
      asObject(raw.inputSchema) ??
      asObject(raw.parameters) ?? { type: "object", properties: {} },
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export interface ComposioCatalogItem {
  slug: string;
  name: string;
  logo: string | null;
  connected: boolean;
  noAuth: boolean;
}

export function filterCatalog(items: ComposioCatalogItem[], query: string): ComposioCatalogItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.filter(
    (item) => item.name.toLowerCase().includes(needle) || item.slug.toLowerCase().includes(needle),
  );
}

export async function collectPages<T>(
  fetchPage: (cursor?: string) => Promise<{ items: T[]; cursor?: string }>,
  maxPages = 200,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetchPage(cursor);
    items.push(...result.items);
    if (!result.cursor) break;
    cursor = result.cursor;
  }
  return items;
}

export function executeSessionKey(toolkits: string[]): string {
  return [...new Set(toolkits.map((slug) => slug.trim()).filter(Boolean))].sort().join(",");
}

/** Long-lived API processes must not keep a Composio session per user forever. */
export const COMPOSIO_SESSION_CACHE_LIMIT = 64;

export function setBounded<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  limit = COMPOSIO_SESSION_CACHE_LIMIT,
): void {
  if (map.has(key)) map.delete(key);
  else if (map.size >= limit) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

export class ComposioConnector implements ConnectorProvider, ConnectionAuthProvider {
  private client: Composio | undefined;
  private clientKey: string | undefined;
  private readonly options: ComposioConnectorOptions;
  private keyCache: { value: string | undefined; at: number } | undefined;
  private readonly catalogSessions = new Map<string, string>();
  private readonly executeSessions = new Map<string, { sessionId: string; key: string }>();

  /** Tests pass a fake SDK; production resolves the key from env or the deployment settings. */
  constructor(clientOrOptions?: Composio | ComposioConnectorOptions) {
    if (clientOrOptions && isConnectorOptions(clientOrOptions)) {
      this.options = clientOrOptions;
      this.client = clientOrOptions.client;
    } else {
      this.options = { client: clientOrOptions };
      this.client = clientOrOptions;
    }
  }

  /** The key in force right now, without opening a session. */
  async resolveApiKey(now: number = Date.now()): Promise<string | undefined> {
    if (this.options.envApiKey) return this.options.envApiKey;
    if (!this.options.loadStoredKey) return undefined;
    if (this.keyCache && now - this.keyCache.at < COMPOSIO_KEY_TTL_MS) return this.keyCache.value;
    const value = (await this.options.loadStoredKey())?.trim() || undefined;
    this.keyCache = { value, at: now };
    return value;
  }

  /** Forget the cached stored key — call after the owner saves or removes one. */
  invalidateKey(): void {
    this.keyCache = undefined;
  }

  /** True when a catalog can be shown: an SDK was injected or a key can be resolved. */
  async available(): Promise<boolean> {
    if (this.options.client) return true;
    return Boolean(await this.resolveApiKey());
  }

  describe() {
    return {
      id: "composio",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    };
  }

  async sessionFor(userId: string): Promise<ComposioSession> {
    const composio = await this.sdk();
    const existing = this.catalogSessions.get(userId);
    if (existing) {
      try {
        return await composio.sessions.use(existing);
      } catch {
        this.catalogSessions.delete(userId);
      }
    }
    const session = await composio.create(userId, {
      manageConnections: false,
      sandbox: { enable: false },
    });
    setBounded(this.catalogSessions, userId, session.sessionId);
    return session;
  }

  async sessionForExecute(userId: string, toolkits: string[]): Promise<ComposioSession> {
    const key = executeSessionKey(toolkits);
    if (!key) return this.sessionFor(userId);
    const composio = await this.sdk();
    const existing = this.executeSessions.get(userId);
    if (existing?.key === key) {
      try {
        return await composio.sessions.use(existing.sessionId);
      } catch {
        this.executeSessions.delete(userId);
      }
    }
    const session = await composio.create(userId, {
      manageConnections: false,
      sandbox: { enable: false },
      toolkits: key.split(","),
      sessionPreset: "direct_tools",
    });
    setBounded(this.executeSessions, userId, { sessionId: session.sessionId, key });
    return session;
  }

  async catalog(userId: string, query?: string): Promise<ComposioCatalogItem[]> {
    const [directory, connected] = await Promise.all([
      this.directory(),
      this.connectedSlugs(userId),
    ]);
    return filterCatalog(mergeCatalogWithConnected(directory, connected), query ?? "");
  }

  async warmDirectory(): Promise<void> {
    await this.directory();
  }

  private async directory(): Promise<ToolkitDirectoryEntry[]> {
    return composioToolkitDirectory.get(() => this.loadDirectory());
  }

  private async loadDirectory(): Promise<ToolkitDirectoryEntry[]> {
    const session = await this.sessionFor("__quibt_catalog__");
    const toolkits = await collectPages((cursor) => session.toolkits({ limit: 50, cursor }));
    return toolkits.map((toolkit) => ({
      slug: toolkit.slug,
      name: toolkit.name,
      logo: toolkit.logo ?? null,
      noAuth: Boolean(toolkit.isNoAuth),
    }));
  }

  private async connectedSlugs(userId: string): Promise<string[]> {
    const session = await this.sessionFor(userId);
    const connected = await collectPages((cursor) =>
      session.toolkits({ isConnected: true, limit: 50, cursor }),
    );
    return connected.map((toolkit) => toolkit.slug);
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const toolkits = context.connectedProviders ?? [];
    if (toolkits.length === 0) return [];
    const session = await this.sessionForExecute(context.userId, toolkits);
    const raw = await session.tools();
    return asConnectorTools(raw);
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    try {
      const session = await this.sessionForExecute(
        context.userId,
        context.connectedProviders ?? [],
      );
      const result = await session.execute(call.tool, call.args ?? {});
      if (result.error) {
        yield { type: "error", message: sanitizeComposioError(result.error) };
        return;
      }
      const logId = collectLogIds(result)[0] ?? "";
      yield {
        type: "result",
        data: {
          data: sanitizePayload(result.data),
          logId,
        },
      };
    } catch (error) {
      yield { type: "error", message: sanitizeComposioError(error) };
    }
  }

  async begin(
    request: { provider: string; redirectUrl: string },
    context: AdapterContext,
  ): Promise<{ authorizationUrl: string | null; state: string }> {
    const session = await this.sessionFor(context.userId);
    try {
      const connectionRequest = await session.authorize(request.provider, {
        callbackUrl: request.redirectUrl,
      });
      if (!connectionRequest.redirectUrl) {
        await connectionRequest.waitForConnection(20_000).catch(() => undefined);
      }
      return {
        authorizationUrl: connectionRequest.redirectUrl ?? null,
        state: connectionRequest.id || request.provider,
      };
    } catch (error) {
      if (isNoAuthToolkitError(error)) {
        return { authorizationUrl: null, state: request.provider };
      }
      throw new Error(sanitizeComposioError(error));
    }
  }

  async connectionReady(userId: string, slug: string): Promise<boolean> {
    const session = await this.sessionFor(userId);
    const page = await session.toolkits({ search: slug, limit: 50 });
    const match = page.items.find((item) => item.slug === slug);
    if (!match) return false;
    return Boolean(match.connection?.isActive) || Boolean(match.isNoAuth);
  }

  /**
   * Finalizes an OAuth connection.
   *
   * `state` is the connection request id from {@link begin} — which in the
   * Composio SDK *is* the connected account id. Composio's own callback
   * exchanges the provider `code` server side, so the SDK exposes no place to
   * hand it back; all we can do is wait for the account to flip to active.
   * The wait is short on purpose: callers poll `connections.complete`.
   */
  async complete(
    request: { state: string; code?: string },
    _context: AdapterContext,
  ): Promise<{ connectionRef: string }> {
    if (!request.state) throw new Error("Conexão sem referência do provedor.");
    const account = await (await this.sdk()).connectedAccounts.waitForConnection(
      request.state,
      COMPLETE_WAIT_MS,
    );
    return { connectionRef: account.id || request.state };
  }

  async revoke(connectionRef: string, context: AdapterContext): Promise<void> {
    const accountId = await this.connectedAccountId(context.userId, connectionRef);
    if (accountId) await (await this.sdk()).connectedAccounts.delete(accountId);
  }

  async connectedAccountId(userId: string, slug: string): Promise<string | undefined> {
    const session = await this.sessionFor(userId);
    const toolkits = await session.toolkits({ isConnected: true });
    return toolkits.items.find((item) => item.slug === slug)?.connection?.connectedAccount?.id;
  }

  private async sdk(): Promise<Composio> {
    if (this.options.client) return this.options.client;
    const apiKey = await this.resolveApiKey();
    if (!apiKey) throw new ComposioKeyMissingError();
    if (!this.client || this.clientKey !== apiKey) {
      // A new key means new sessions too: the old ones were minted under the old account.
      this.catalogSessions.clear();
      this.executeSessions.clear();
      this.client = new Composio({ apiKey });
      this.clientKey = apiKey;
    }
    return this.client;
  }
}

function isConnectorOptions(
  value: Composio | ComposioConnectorOptions,
): value is ComposioConnectorOptions {
  return (
    typeof value === "object" &&
    value !== null &&
    !("sessions" in value) &&
    ("client" in value || "envApiKey" in value || "loadStoredKey" in value)
  );
}

export class CompositeConnector implements ConnectorProvider {
  constructor(
    readonly destination: DestinationEmulator,
    readonly composio?: ComposioConnector,
  ) {}

  describe() {
    return this.composio?.describe() ?? this.destination.describe();
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const dest = await this.destination.discoverTools(context);
    if (!this.composio) return dest;
    try {
      const extra = await this.composio.discoverTools(context);
      const destNames = new Set(dest.map((tool) => tool.name));
      return [...dest, ...extra.filter((tool) => !destNames.has(tool.name))];
    } catch {
      return dest;
    }
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    if (call.tool === "destination.write" || !this.composio) {
      yield* this.destination.execute(call, context);
      return;
    }
    yield* this.composio.execute(call, context);
  }
}

export function createConnectorStack(
  composio: boolean | { envApiKey?: string; loadStoredKey?: () => Promise<string | undefined> },
) {
  const destination = new DestinationEmulator();
  const connector = createComposioConnector(composio);
  return {
    destination,
    composio: connector,
    connector: new CompositeConnector(destination, connector),
  };
}

function createComposioConnector(
  composio: boolean | { envApiKey?: string; loadStoredKey?: () => Promise<string | undefined> },
): ComposioConnector | undefined {
  if (typeof composio === "boolean") return composio ? new ComposioConnector() : undefined;
  if (process.env.VITEST) return undefined;
  const envApiKey = composio.envApiKey?.trim() || undefined;
  if (!envApiKey && !composio.loadStoredKey) return undefined;
  return new ComposioConnector({ envApiKey, loadStoredKey: composio.loadStoredKey });
}

export function collectLogIds(value: unknown): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const record = node as Record<string, unknown>;
    for (const [key, nested] of Object.entries(record)) {
      if (
        (key === "logId" || key === "log_id") &&
        typeof nested === "string" &&
        nested &&
        !seen.has(nested)
      ) {
        seen.add(nested);
        ids.push(nested);
      } else {
        walk(nested);
      }
    }
  };
  walk(value);
  return ids;
}

export function isNoAuthToolkitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("ToolkitsIsNoAuth") || message.includes("does not require authentication")
  );
}

export function sanitizeComposioError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactConnectorText(message);
}

function sanitizePayload(data: unknown): unknown {
  try {
    return JSON.parse(redactConnectorText(JSON.stringify(data)));
  } catch {
    return { ok: true };
  }
}

function redactConnectorText(value: string): string {
  return value
    .replace(/COMPOSIO_API_KEY[=:]?\s*\S+/gi, "COMPOSIO_API_KEY=[redacted]")
    .replace(/ak_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/ck_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/sk-or-v1-[A-Za-z0-9]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}
