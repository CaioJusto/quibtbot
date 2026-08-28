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
  COMPOSIO_PAGE_TIMEOUT_MS,
  COMPOSIO_PAGES_BUDGET_MS,
  COMPOSIO_REQUEST_TIMEOUT_MS,
  ComposioTimeoutError,
  type ComposioUnknownOutcomeError,
  composioToolkitDirectory,
  isComposioUnknownOutcome,
  mergeCatalogWithConnected,
  type ToolkitDirectoryEntry,
  withComposioDeadline,
  withComposioMutationDeadline,
} from "./composio-catalog-cache.js";
import { DestinationEmulator } from "./destination-emulator.js";

type ComposioSession = Awaited<ReturnType<Composio["create"]>>;

/**
 * Buraco de tipagem do SDK: o objeto devolvido por `composio.create()` é um
 * `ToolRouterSession`, cujo `execute`/`authorize` aceita `requestOptions` com `signal`
 * (@composio/core 0.16 cancela o fetch de verdade). O tipo público `Session`, porém,
 * declara os dois métodos SEM esse último parâmetro. Estes moldes são a ponte, e ficam
 * aqui, à vista, para o dia em que o SDK corrigir a declaração.
 */
type SessionRequestOptions = { signal?: AbortSignal };

function executeWithSignal(
  session: ComposioSession,
  tool: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): ReturnType<ComposioSession["execute"]> {
  const execute = session.execute as unknown as (
    toolSlug: string,
    args?: Record<string, unknown>,
    options?: undefined,
    requestOptions?: SessionRequestOptions,
  ) => ReturnType<ComposioSession["execute"]>;
  return execute.call(session, tool, args, undefined, { signal });
}

function authorizeWithSignal(
  session: ComposioSession,
  provider: string,
  options: { callbackUrl: string },
  signal: AbortSignal,
): ReturnType<ComposioSession["authorize"]> {
  const authorize = session.authorize as unknown as (
    toolkit: string,
    options?: { callbackUrl?: string },
    requestOptions?: SessionRequestOptions,
  ) => ReturnType<ComposioSession["authorize"]>;
  return authorize.call(session, provider, options, { signal });
}

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

/**
 * Varre as páginas do Composio com dois tetos: cada página tem prazo, e a varredura
 * inteira tem um orçamento de parede. Estourou, o erro sobe — meio catálogo guardado por
 * uma hora seria pior que uma tentativa nova depois da janela de espera.
 */
export async function collectPages<T>(
  fetchPage: (cursor?: string) => Promise<{ items: T[]; cursor?: string }>,
  options: {
    maxPages?: number;
    pageTimeoutMs?: number;
    budgetMs?: number;
    signal?: AbortSignal;
    now?: () => number;
  } = {},
): Promise<T[]> {
  const maxPages = options.maxPages ?? 200;
  const now = options.now ?? Date.now;
  const pageTimeoutMs = options.pageTimeoutMs ?? COMPOSIO_PAGE_TIMEOUT_MS;
  const deadline = now() + (options.budgetMs ?? COMPOSIO_PAGES_BUDGET_MS);
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const left = deadline - now();
    if (left <= 0) throw new ComposioTimeoutError("catálogo");
    const result = await withComposioDeadline(fetchPage(cursor), "catálogo", {
      timeoutMs: Math.min(pageTimeoutMs, left),
      signal: options.signal,
    });
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

  /**
   * O prazo das LEITURAS (catálogo, apps, ferramentas, sessão). Corta a espera e devolve o
   * turno; a promessa órfã morre com o processo. Ler de novo não muda nada lá fora, então
   * estourar aqui é {@link ComposioTimeoutError} — quem chamou pode repetir.
   */
  private deadline<T>(
    work: Promise<T>,
    label: string,
    signal?: AbortSignal,
    timeoutMs = COMPOSIO_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    return withComposioDeadline(work, label, { signal, timeoutMs });
  }

  /**
   * O prazo das MUTAÇÕES (executar ferramenta, autorizar, revogar). Passa o `signal` do
   * SDK para dentro, então o pedido é cancelado de verdade; estourou, o resultado é
   * DESCONHECIDO ({@link ComposioUnknownOutcomeError}) e ninguém repete sozinho.
   */
  private mutationDeadline<T>(
    start: (signal: AbortSignal) => Promise<T>,
    label: string,
    signal?: AbortSignal,
    options: { reconcileKey?: string; timeoutMs?: number } = {},
  ): Promise<T> {
    return withComposioMutationDeadline(start, label, {
      signal,
      timeoutMs: options.timeoutMs ?? COMPOSIO_REQUEST_TIMEOUT_MS,
      reconcileKey: options.reconcileKey,
    });
  }

  async sessionFor(userId: string, signal?: AbortSignal): Promise<ComposioSession> {
    const composio = await this.sdk();
    const existing = this.catalogSessions.get(userId);
    if (existing) {
      try {
        // Uma sessão reaproveitada tem meio prazo: se ela pendura, ainda dá tempo de
        // abrir uma nova dentro da paciência de quem chamou.
        return await this.deadline(
          composio.sessions.use(existing),
          "sessão",
          signal,
          COMPOSIO_REQUEST_TIMEOUT_MS / 2,
        );
      } catch {
        this.catalogSessions.delete(userId);
      }
    }
    const session = await this.deadline(
      composio.create(userId, {
        manageConnections: false,
        sandbox: { enable: false },
      }),
      "sessão",
      signal,
    );
    setBounded(this.catalogSessions, userId, session.sessionId);
    return session;
  }

  async sessionForExecute(
    userId: string,
    toolkits: string[],
    signal?: AbortSignal,
  ): Promise<ComposioSession> {
    const key = executeSessionKey(toolkits);
    if (!key) return this.sessionFor(userId, signal);
    const composio = await this.sdk();
    const existing = this.executeSessions.get(userId);
    if (existing?.key === key) {
      try {
        return await this.deadline(
          composio.sessions.use(existing.sessionId),
          "sessão",
          signal,
          COMPOSIO_REQUEST_TIMEOUT_MS / 2,
        );
      } catch {
        this.executeSessions.delete(userId);
      }
    }
    const session = await this.deadline(
      composio.create(userId, {
        manageConnections: false,
        sandbox: { enable: false },
        toolkits: key.split(","),
        sessionPreset: "direct_tools",
      }),
      "sessão",
      signal,
    );
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
    const session = await this.sessionForExecute(context.userId, toolkits, context.signal);
    const raw = await this.deadline(session.tools(), "ferramentas", context.signal);
    return asConnectorTools(raw);
  }

  /**
   * Executar uma ferramenta é MUTAÇÃO: manda e-mail, manda mensagem, cria registro.
   *
   * Por isso o prazo aqui não é "expirou, tenta de novo". O pedido é cancelado de verdade
   * (o SDK aceita `signal`), mas cancelar o fetch não desfaz o que o servidor já fez — e o
   * SDK não tem chave de idempotência nem consulta do estado da execução (o `logId` só vem
   * na resposta que não chegou). Então o prazo estourado vira um RESULTADO explícito de
   * desconhecido: quem lê (modelo ou pessoa) vê "pode ter acontecido, não repita", em vez
   * de um erro que convida a mandar o mesmo e-mail de novo.
   */
  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    try {
      const session = await this.sessionForExecute(
        context.userId,
        context.connectedProviders ?? [],
        context.signal,
      );
      const result = await this.mutationDeadline(
        (signal) => executeWithSignal(session, call.tool, call.args ?? {}, signal),
        call.tool,
        context.signal,
        { reconcileKey: call.executionId },
      );
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
      if (isComposioUnknownOutcome(error)) {
        yield { type: "log", message: error.message };
        yield { type: "result", data: unknownOutcomeResult(call, error) };
        return;
      }
      // Abrir a sessão, montar o pedido: nada disso tocou o app do usuário, então
      // continua sendo um erro comum — repetir é seguro.
      yield { type: "error", message: sanitizeComposioError(error) };
    }
  }

  async begin(
    request: { provider: string; redirectUrl: string },
    context: AdapterContext,
  ): Promise<{ authorizationUrl: string | null; state: string }> {
    const session = await this.sessionFor(context.userId, context.signal);
    try {
      // Autorizar cria um pedido de conexão no Composio: é mutação. Estourou o prazo, o
      // pedido pode existir lá — quem chamou não pode abrir outro sozinho.
      const connectionRequest = await this.mutationDeadline(
        (signal) =>
          authorizeWithSignal(
            session,
            request.provider,
            { callbackUrl: request.redirectUrl },
            signal,
          ),
        "conexão",
        context.signal,
      );
      if (!connectionRequest.redirectUrl) {
        await this.deadline(
          connectionRequest.waitForConnection(20_000),
          "conexão",
          context.signal,
          COMPOSIO_REQUEST_TIMEOUT_MS + 2_000,
        ).catch(() => undefined);
      }
      return {
        authorizationUrl: connectionRequest.redirectUrl ?? null,
        state: connectionRequest.id || request.provider,
      };
    } catch (error) {
      if (isNoAuthToolkitError(error)) {
        return { authorizationUrl: null, state: request.provider };
      }
      // O desconhecido sobe com a classe original: quem chamou precisa saber que isto
      // não é "falhou, tente de novo".
      if (isComposioUnknownOutcome(error)) throw error;
      throw new Error(sanitizeComposioError(error));
    }
  }

  async connectionReady(userId: string, slug: string, signal?: AbortSignal): Promise<boolean> {
    const session = await this.sessionFor(userId, signal);
    const page = await this.deadline(session.toolkits({ search: slug, limit: 50 }), "apps", signal);
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
   *
   * Esperar a conta virar ativa é CONSULTA DE ESTADO, não mutação: nada é criado aqui, e
   * perguntar de novo não tem efeito no app do usuário. Por isso o prazo continua sendo o
   * de leitura — este é o caminho que já reconcilia o resultado do {@link begin}.
   */
  async complete(
    request: { state: string; code?: string },
    _context: AdapterContext,
  ): Promise<{ connectionRef: string }> {
    if (!request.state) throw new Error("Conexão sem referência do provedor.");
    const account = await this.deadline(
      (await this.sdk()).connectedAccounts.waitForConnection(request.state, COMPLETE_WAIT_MS),
      "conexão",
      _context.signal,
      COMPLETE_WAIT_MS + 2_000,
    );
    return { connectionRef: account.id || request.state };
  }

  /**
   * Revogar é mutação, mas de efeito idempotente: o fim desejado é "a conta não existe".
   * Ainda assim, o prazo estourado não vira "tenta de novo" cego — primeiro consultamos o
   * estado. Sumiu, acabou. Continua lá, o erro é o de leitura (repetir um delete não
   * duplica nada). Só quando nem a consulta responde é que o resultado é desconhecido.
   */
  async revoke(connectionRef: string, context: AdapterContext): Promise<void> {
    const accountId = await this.connectedAccountId(context.userId, connectionRef, context.signal);
    if (!accountId) return;
    try {
      await this.mutationDeadline(
        async (signal) => (await this.sdk()).connectedAccounts.delete(accountId, { signal }),
        "revogar",
        context.signal,
        { reconcileKey: accountId },
      );
    } catch (error) {
      if (!isComposioUnknownOutcome(error)) throw error;
      const check = await this.connectedAccountId(context.userId, connectionRef).then(
        (id) => ({ answered: true as const, id }),
        () => ({ answered: false as const, id: undefined }),
      );
      // Nem a consulta respondeu: continua desconhecido.
      if (!check.answered) throw error;
      // Ainda conectada: o delete não pegou, e repeti-lo tem o mesmo fim.
      if (check.id) throw new ComposioTimeoutError("revogar");
    }
  }

  async connectedAccountId(
    userId: string,
    slug: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const session = await this.sessionFor(userId, signal);
    const toolkits = await this.deadline(session.toolkits({ isConnected: true }), "apps", signal);
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

/** O que marca um resultado de ferramenta como "não sabemos se aconteceu". */
export const COMPOSIO_UNKNOWN_OUTCOME = "composio_unknown_outcome";

export type ComposioUnknownOutcomeResult = {
  outcome: typeof COMPOSIO_UNKNOWN_OUTCOME;
  status: "unknown";
  /** Explícito para quem lê o JSON: ninguém repete esta chamada sozinho. */
  retry: false;
  tool: string;
  executionId: string;
  message: string;
};

/**
 * O resultado que sai no lugar da resposta que não chegou. É um `result`, não um `error`,
 * de propósito: um erro convida o modelo (e o retry do job) a mandar o mesmo e-mail de
 * novo; isto aqui diz o que houve e manda conferir antes.
 */
function unknownOutcomeResult(
  call: ConnectorCall,
  error: ComposioUnknownOutcomeError,
): ComposioUnknownOutcomeResult {
  return {
    outcome: COMPOSIO_UNKNOWN_OUTCOME,
    status: "unknown",
    retry: false,
    tool: call.tool,
    executionId: call.executionId ?? "",
    message: error.message,
  };
}

/** Quem consome o resultado de uma ferramenta distingue "desconhecido" de "falhou". */
export function isComposioUnknownOutcomeResult(
  value: unknown,
): value is ComposioUnknownOutcomeResult {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { outcome?: unknown }).outcome === COMPOSIO_UNKNOWN_OUTCOME
  );
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
