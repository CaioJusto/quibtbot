import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPOSIO_DIRECTORY_RETRY_MS,
  ComposioTimeoutError,
  ComposioUnknownOutcomeError,
  clearComposioReconcileLog,
  composioReconcileLog,
  createToolkitDirectoryCache,
  isComposioUnknownOutcome,
  isRetryableComposioFailure,
  mergeCatalogWithConnected,
  type ToolkitDirectoryEntry,
  withComposioDeadline,
  withComposioMutationDeadline,
} from "./composio-catalog-cache.js";

describe("composio toolkit directory cache", () => {
  it("loads once within the TTL and coalesces inflight reads", async () => {
    let loads = 0;
    const cache = createToolkitDirectoryCache({ ttlMs: 60_000, now: () => 1_000 });
    const loader = async () => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [{ slug: "github", name: "GitHub", logo: null, noAuth: false }];
    };
    const [a, b] = await Promise.all([cache.get(loader), cache.get(loader)]);
    expect(loads).toBe(1);
    expect(a).toHaveLength(1);
    expect(b[0]?.slug).toBe("github");
    await cache.get(loader);
    expect(loads).toBe(1);
  });

  it("returns stale items while a TTL refresh runs", async () => {
    let now = 0;
    let loads = 0;
    const cache = createToolkitDirectoryCache({ ttlMs: 10, now: () => now });
    const first = await cache.get(async () => {
      loads += 1;
      return [{ slug: "gmail", name: "Gmail", logo: null, noAuth: false }];
    });
    expect(first[0]?.slug).toBe("gmail");
    now = 50;
    let resolveRefresh: (items: typeof first) => void = () => undefined;
    const refresh = new Promise<typeof first>((resolve) => {
      resolveRefresh = resolve;
    });
    const stale = await cache.get(() => {
      loads += 1;
      return refresh;
    });
    expect(stale[0]?.slug).toBe("gmail");
    expect(loads).toBe(2);
    resolveRefresh([{ slug: "slack", name: "Slack", logo: null, noAuth: false }]);
    await refresh;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const next = await cache.get(async () => {
      loads += 1;
      return [{ slug: "linear", name: "Linear", logo: null, noAuth: false }];
    });
    expect(next[0]?.slug).toBe("slack");
    expect(loads).toBe(2);
  });

  it("marks only connected slugs on the cached directory", () => {
    const items = mergeCatalogWithConnected(
      [
        { slug: "github", name: "GitHub", logo: null, noAuth: false },
        { slug: "hackernews", name: "Hacker News", logo: null, noAuth: true },
      ],
      ["hackernews"],
    );
    expect(items.find((item) => item.slug === "github")?.connected).toBe(false);
    expect(items.find((item) => item.slug === "hackernews")?.connected).toBe(true);
  });
});

describe("composio directory cache under a slow Composio", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const github: ToolkitDirectoryEntry[] = [
    { slug: "github", name: "GitHub", logo: null, noAuth: false },
  ];

  it("desiste de um loader pendurado em vez de segurar o turno para sempre", async () => {
    vi.useFakeTimers();
    let loads = 0;
    const cache = createToolkitDirectoryCache({ loadTimeoutMs: 5_000 });
    const hung = () => {
      loads += 1;
      return new Promise<ToolkitDirectoryEntry[]>(() => undefined);
    };
    const pending = cache.get(hung);
    const settled = expect(pending).rejects.toThrow(/demorou demais/);
    await vi.advanceTimersByTimeAsync(5_000);
    await settled;
    expect(loads).toBe(1);
  });

  it("não repete a tentativa antes da janela de espera", async () => {
    vi.useFakeTimers();
    let loads = 0;
    const cache = createToolkitDirectoryCache({ loadTimeoutMs: 5_000 });
    const failing = async () => {
      loads += 1;
      throw new Error("Composio 503");
    };
    await expect(cache.get(failing)).rejects.toThrow(/503/);
    expect(loads).toBe(1);

    // Cem telas abrindo o catálogo não viram cem chamadas: a falha vale pela janela.
    for (let i = 0; i < 5; i += 1) {
      await expect(cache.get(failing)).rejects.toThrow();
    }
    expect(loads).toBe(1);

    await vi.advanceTimersByTimeAsync(COMPOSIO_DIRECTORY_RETRY_MS);
    const items = await cache.get(async () => github);
    expect(items).toEqual(github);
    expect(loads).toBe(1);
  });

  it("serve o catálogo velho e não empilha refresh enquanto o Composio está fora", async () => {
    vi.useFakeTimers();
    let loads = 0;
    const cache = createToolkitDirectoryCache({ ttlMs: 1_000, loadTimeoutMs: 5_000 });
    expect(await cache.get(async () => github)).toEqual(github);
    await vi.advanceTimersByTimeAsync(2_000);

    const broken = async () => {
      loads += 1;
      throw new Error("Composio 503");
    };
    expect(await cache.get(broken)).toEqual(github);
    await vi.advanceTimersByTimeAsync(1);
    expect(await cache.get(broken)).toEqual(github);
    expect(loads).toBe(1);
  });
});

describe("prazo de mutação do composio", () => {
  afterEach(() => {
    vi.useRealTimers();
    clearComposioReconcileLog();
  });

  const forever = () => new Promise<never>(() => undefined);

  it("estourou o prazo: resultado DESCONHECIDO, e não um timeout que convida a repetir", async () => {
    vi.useFakeTimers();
    clearComposioReconcileLog();
    let seen: AbortSignal | undefined;
    const pending = withComposioMutationDeadline(
      (signal) => {
        seen = signal;
        return forever();
      },
      "GMAIL_SEND_EMAIL",
      { timeoutMs: 1_000, reconcileKey: "exec-1" },
    );
    const settled = expect(pending).rejects.toBeInstanceOf(ComposioUnknownOutcomeError);
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;

    // Cancelamento real: o SDK recebe o abort (é o máximo que ele oferece — não há
    // chave de idempotência nem consulta do estado da execução).
    expect(seen?.aborted).toBe(true);
    const second = withComposioMutationDeadline(forever, "GMAIL_SEND_EMAIL", {
      timeoutMs: 1_000,
    }).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await second;
    // Não vale como leitura: quem chamou não pode repetir sozinho.
    expect(isRetryableComposioFailure(error)).toBe(false);
    expect(isComposioUnknownOutcome(error)).toBe(true);
    expect((error as Error).message).toMatch(/não repita automaticamente/);

    // E o que ficou em aberto vai para a fila de reconciliação.
    expect(composioReconcileLog().map((entry) => entry.key)).toContain("exec-1");
    expect(composioReconcileLog()[0]?.state).toBe("pending");
  });

  it("uma leitura que estoura o prazo continua podendo ser repetida", async () => {
    vi.useFakeTimers();
    const late = withComposioDeadline(forever(), "catálogo", { timeoutMs: 1_000 });
    const settled = expect(late).rejects.toBeInstanceOf(ComposioTimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
    const error = await withComposioDeadline(
      Promise.reject(new ComposioTimeoutError("catálogo")),
      "catálogo",
    ).catch((err: unknown) => err);
    expect(isRetryableComposioFailure(error)).toBe(true);
    expect(isComposioUnknownOutcome(error)).toBe(false);
  });

  it("o chamador que desistiu ANTES de começar recebe um timeout comum: nada saiu daqui", async () => {
    const controller = new AbortController();
    controller.abort();
    let started = 0;
    const error = await withComposioMutationDeadline(
      () => {
        started += 1;
        return forever();
      },
      "GMAIL_SEND_EMAIL",
      { signal: controller.signal },
    ).catch((err: unknown) => err);
    expect(started).toBe(0);
    expect(isComposioUnknownOutcome(error)).toBe(false);
    expect(isRetryableComposioFailure(error)).toBe(true);
  });

  it("não perde o abort que acontece durante o próprio start", async () => {
    const controller = new AbortController();
    let inner: AbortSignal | undefined;
    const error = await withComposioMutationDeadline(
      (signal) => {
        inner = signal;
        controller.abort();
        return forever();
      },
      "GMAIL_SEND_EMAIL",
      { signal: controller.signal },
    ).catch((failure: unknown) => failure);
    expect(inner?.aborted).toBe(true);
    expect(error).toBeInstanceOf(ComposioUnknownOutcomeError);
  });

  it("a resposta que chega tarde é anotada para reconciliação", async () => {
    vi.useFakeTimers();
    clearComposioReconcileLog();
    let finish: (value: string) => void = () => undefined;
    const late = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const pending = withComposioMutationDeadline(() => late, "GMAIL_SEND_EMAIL", {
      timeoutMs: 1_000,
      reconcileKey: "exec-2",
    });
    const settled = expect(pending).rejects.toBeInstanceOf(ComposioUnknownOutcomeError);
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
    expect(composioReconcileLog()[0]).toMatchObject({ key: "exec-2", state: "pending" });
    finish("o e-mail saiu");
    await vi.advanceTimersByTimeAsync(0);
    expect(composioReconcileLog()[0]?.state).toBe("late-success");
  });

  it("entrega o valor quando o Composio responde dentro do prazo", async () => {
    await expect(withComposioMutationDeadline(async () => "ok", "GMAIL_SEND_EMAIL")).resolves.toBe(
      "ok",
    );
    await expect(
      withComposioMutationDeadline(async () => {
        throw new Error("400 argumento inválido");
      }, "GMAIL_SEND_EMAIL"),
    ).rejects.toThrow(/argumento inválido/);
  });
});
