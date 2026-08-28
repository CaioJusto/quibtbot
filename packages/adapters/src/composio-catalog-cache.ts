/**
 * O catálogo de apps do Composio, e o prazo que toda chamada ao Composio respeita.
 *
 * Há DOIS prazos, porque há dois tipos de chamada:
 *
 * - LEITURA (catálogo, lista de apps, lista de ferramentas, status de conexão):
 *   {@link withComposioDeadline} corta a ESPERA. A promessa do SDK segue viva e ignorada,
 *   mas ler duas vezes não causa efeito no mundo, então estourar o prazo é
 *   {@link ComposioTimeoutError} — um erro comum, que pode ser repetido.
 * - MUTAÇÃO (executar ferramenta, autorizar, revogar): repetir manda o e-mail duas vezes.
 *   {@link withComposioMutationDeadline} pede o cancelamento REAL ao SDK (o `signal` de
 *   `ComposioRequestOptions`, aceito desde @composio/core 0.16) e, quando o prazo estoura,
 *   devolve {@link ComposioUnknownOutcomeError}: resultado DESCONHECIDO, não repetir
 *   automaticamente. O que o SDK NÃO oferece: chave de idempotência (o próprio SDK diz que
 *   "backend-honoured idempotency keys" ainda são trabalho futuro) e consulta do estado de
 *   uma execução pelo id da requisição — o `logId` só volta na resposta que não chegou.
 *   Abortar o fetch também não desfaz o que o servidor já fez; por isso o resultado é
 *   desconhecido, e não "não aconteceu".
 *
 * O cache do diretório tem os mesmos cuidados: um loader pendurado é abandonado depois de
 * `loadTimeoutMs`, e uma falha vale por {@link COMPOSIO_DIRECTORY_RETRY_MS} — cem telas
 * abrindo Plugins com o Composio fora não viram cem chamadas.
 */

/** Quanto tempo uma chamada ao Composio pode segurar o turno do bot. */
export const COMPOSIO_REQUEST_TIMEOUT_MS = 20_000;

/** Uma página de catálogo é barata; se demorar isso, o Composio não está bem. */
export const COMPOSIO_PAGE_TIMEOUT_MS = 10_000;

/** Teto de parede para varrer todas as páginas, some quantas páginas forem. */
export const COMPOSIO_PAGES_BUDGET_MS = 30_000;

/** Depois de uma falha do diretório, a próxima tentativa só sai depois disso. */
export const COMPOSIO_DIRECTORY_RETRY_MS = 60_000;

/** O erro que o usuário lê quando o Composio não respondeu a tempo. */
export class ComposioTimeoutError extends Error {
  constructor(readonly label: string) {
    super(`O Composio demorou demais para responder (${label}). Tente de novo em instantes.`);
    this.name = "ComposioTimeoutError";
  }
}

/**
 * Espera `work` por no máximo `timeoutMs`, ou até o `signal` de quem chamou abortar.
 * O trabalho em si não é cancelável — quem é cortado é a espera.
 */
export function withComposioDeadline<T>(
  work: Promise<T>,
  label: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? COMPOSIO_REQUEST_TIMEOUT_MS;
  const signal = options.signal;
  if (signal?.aborted) return Promise.reject(new ComposioTimeoutError(label));
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const settle = (run: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      run();
    };
    const onAbort = () => settle(() => reject(new ComposioTimeoutError(label)));
    const timer = setTimeout(
      () => settle(() => reject(new ComposioTimeoutError(label))),
      timeoutMs,
    );
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

/**
 * O resultado de uma MUTAÇÃO que estourou o prazo: pode ter acontecido, pode não ter.
 * Quem recebe isto não pode repetir sozinho — tem de reconciliar (olhar o estado real)
 * ou perguntar para a pessoa. É por isso que não herda de {@link ComposioTimeoutError}:
 * um timeout de leitura é "tenta de novo", este aqui não é.
 */
export class ComposioUnknownOutcomeError extends Error {
  /** Marcador explícito para quem checa por forma em vez de `instanceof`. */
  readonly outcome = "unknown" as const;
  /** Nunca. Repetir uma mutação sem confirmação é o que duplica o e-mail. */
  readonly retryable = false as const;

  constructor(
    readonly label: string,
    readonly reconcileKey?: string,
  ) {
    super(
      `O Composio não confirmou "${label}" dentro do prazo. A ação pode ter sido concluída — ` +
        "não repita automaticamente; confira no app antes de tentar de novo.",
    );
    this.name = "ComposioUnknownOutcomeError";
  }
}

export function isComposioUnknownOutcome(error: unknown): error is ComposioUnknownOutcomeError {
  return error instanceof ComposioUnknownOutcomeError;
}

/** Leitura que expirou pode ser repetida; mutação sem confirmação, não. */
export function isRetryableComposioFailure(error: unknown): boolean {
  return !isComposioUnknownOutcome(error);
}

export type ComposioReconcileEntry = {
  label: string;
  key?: string;
  at: number;
  /** `pending` até a promessa órfã se resolver; depois, o que ela disse. */
  state: "pending" | "late-success" | "late-failure" | "cancelled";
};

/** Quantas mutações em aberto ficam guardadas para reconciliação. */
export const COMPOSIO_RECONCILE_LOG_LIMIT = 50;

const reconcileLog: ComposioReconcileEntry[] = [];

/** A fila de reconciliação: mutações cujo resultado o Quibt não conhece. */
export function composioReconcileLog(): readonly ComposioReconcileEntry[] {
  return reconcileLog;
}

export function clearComposioReconcileLog(): void {
  reconcileLog.length = 0;
}

function trackForReconcile<T>(
  work: Promise<T>,
  label: string,
  key: string | undefined,
  now: () => number,
): void {
  const entry: ComposioReconcileEntry = { label, key, at: now(), state: "pending" };
  if (reconcileLog.length >= COMPOSIO_RECONCILE_LOG_LIMIT) reconcileLog.shift();
  reconcileLog.push(entry);
  work.then(
    () => {
      entry.state = "late-success";
    },
    (error: unknown) => {
      // O cancelamento que nós mesmos pedimos não conta como falha do servidor:
      // ele diz que a conexão morreu, não que a ação deixou de acontecer.
      entry.state = isCancellationError(error) ? "cancelled" : "late-failure";
    },
  );
}

function isCancellationError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return (
    name === "AbortError" ||
    name === "ComposioRequestCancelledError" ||
    isComposioUnknownOutcome(error)
  );
}

/**
 * O prazo das MUTAÇÕES. Diferente de {@link withComposioDeadline}, aqui quem começa o
 * trabalho somos nós: `start` recebe um `AbortSignal` que é repassado ao SDK, então o
 * pedido HTTP é cancelado de verdade quando o prazo estoura.
 *
 * Estourou o prazo (ou o chamador desistiu depois de começar): rejeita com
 * {@link ComposioUnknownOutcomeError} e a chamada entra na fila de reconciliação.
 * Se o chamador já tinha abortado ANTES de começar, nada saiu daqui — aí o erro é
 * {@link ComposioTimeoutError}, porque repetir é seguro.
 */
export function withComposioMutationDeadline<T>(
  start: (signal: AbortSignal) => Promise<T>,
  label: string,
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    reconcileKey?: string;
    now?: () => number;
  } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? COMPOSIO_REQUEST_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const caller = options.signal;
  // Nada começou: o resultado é conhecido (não aconteceu) e repetir é seguro.
  if (caller?.aborted) return Promise.reject(new ComposioTimeoutError(label));

  const controller = new AbortController();
  let work: Promise<T>;
  try {
    work = start(controller.signal);
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise<T>((resolve, reject) => {
    let done = false;
    const settle = (run: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      caller?.removeEventListener("abort", expire);
      run();
    };
    const expire = () =>
      settle(() => {
        const error = new ComposioUnknownOutcomeError(label, options.reconcileKey);
        // Cancelamento real: o SDK aborta o fetch. Não desfaz o que o servidor já fez.
        controller.abort(error);
        trackForReconcile(work, label, options.reconcileKey, now);
        reject(error);
      });
    const timer = setTimeout(expire, timeoutMs);
    timer.unref?.();
    caller?.addEventListener("abort", expire, { once: true });
    // Fecha a corrida entre o teste `caller.aborted` feito antes de `start()` e a
    // instalação do listener acima. O chamador pode abortar de dentro do próprio start.
    if (caller?.aborted) expire();
    work.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

/**
 * O mesmo prazo, no formato que o `AdapterContext` pede. `new AbortController().signal`
 * nunca aborta: o chamador ficava esperando para sempre por uma chamada do Composio.
 * Com `unref`, o timer pendente também não segura o processo de pé.
 */
export function composioAbortSignal(timeoutMs = COMPOSIO_REQUEST_TIMEOUT_MS): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ComposioTimeoutError("chamada")), timeoutMs);
  timer.unref?.();
  return controller.signal;
}

export type ToolkitDirectoryEntry = {
  slug: string;
  name: string;
  logo: string | null;
  noAuth: boolean;
};

export type ToolkitCatalogEntry = ToolkitDirectoryEntry & { connected: boolean };

export const COMPOSIO_DIRECTORY_TTL_MS = 60 * 60 * 1000;

export function mergeCatalogWithConnected(
  directory: ToolkitDirectoryEntry[],
  connectedSlugs: Iterable<string>,
): ToolkitCatalogEntry[] {
  const connected = new Set(connectedSlugs);
  return directory.map((item) => ({
    ...item,
    connected: connected.has(item.slug),
  }));
}

export function createToolkitDirectoryCache(opts?: {
  ttlMs?: number;
  now?: () => number;
  /** Prazo do loader: passou disso, a espera é abandonada e o inflight é liberado. */
  loadTimeoutMs?: number;
  /** Janela de silêncio depois de uma falha, para não martelar um Composio fora do ar. */
  retryAfterMs?: number;
}) {
  const ttlMs = opts?.ttlMs ?? COMPOSIO_DIRECTORY_TTL_MS;
  const now = opts?.now ?? Date.now;
  const loadTimeoutMs =
    opts?.loadTimeoutMs ?? COMPOSIO_PAGES_BUDGET_MS + COMPOSIO_REQUEST_TIMEOUT_MS;
  const retryAfterMs = opts?.retryAfterMs ?? COMPOSIO_DIRECTORY_RETRY_MS;
  let entry: { items: ToolkitDirectoryEntry[]; fetchedAt: number } | undefined;
  let inflight: Promise<ToolkitDirectoryEntry[]> | undefined;
  let failure: { error: unknown; at: number } | undefined;

  function coolingDown(): boolean {
    return Boolean(failure) && now() - failure!.at < retryAfterMs;
  }

  async function load(loader: () => Promise<ToolkitDirectoryEntry[]>) {
    inflight ??= withComposioDeadline(loader(), "catálogo", { timeoutMs: loadTimeoutMs })
      .then((items) => {
        entry = { items, fetchedAt: now() };
        failure = undefined;
        return items;
      })
      .catch((error: unknown) => {
        failure = { error, at: now() };
        throw error;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  }

  return {
    peek(): ToolkitDirectoryEntry[] | undefined {
      return entry?.items;
    },
    async get(loader: () => Promise<ToolkitDirectoryEntry[]>): Promise<ToolkitDirectoryEntry[]> {
      if (!entry) {
        if (inflight) return inflight;
        // Sem nada em cache e ainda na janela de espera: repete a falha sem chamar de novo.
        if (coolingDown()) throw failure!.error;
        return load(loader);
      }
      if (now() - entry.fetchedAt < ttlMs) return entry.items;
      if (!inflight && !coolingDown()) {
        // Background refresh: keep serving stale items if Composio is down.
        void load(loader).catch(() => undefined);
      }
      return entry.items;
    },
    invalidate() {
      entry = undefined;
      failure = undefined;
    },
  };
}

export const composioToolkitDirectory = createToolkitDirectoryCache();
