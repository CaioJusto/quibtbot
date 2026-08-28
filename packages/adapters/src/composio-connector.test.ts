import type { ConnectorEvent } from "@quibt/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPOSIO_PAGE_TIMEOUT_MS,
  COMPOSIO_PAGES_BUDGET_MS,
  COMPOSIO_REQUEST_TIMEOUT_MS,
  ComposioTimeoutError,
  ComposioUnknownOutcomeError,
  withComposioDeadline,
} from "./composio-catalog-cache.js";
import {
  asConnectorTools,
  COMPOSIO_KEY_TTL_MS,
  COMPOSIO_UNKNOWN_OUTCOME,
  ComposioConnector,
  ComposioKeyMissingError,
  collectLogIds,
  collectPages,
  executeSessionKey,
  filterCatalog,
  isComposioEnabled,
  isComposioUnknownOutcomeResult,
  isNoAuthToolkitError,
  sanitizeComposioError,
  setBounded,
} from "./composio-connector.js";

describe("composio session cache", () => {
  it("evicts the oldest entry when the map is full", () => {
    const map = new Map<string, string>();
    setBounded(map, "a", "1", 2);
    setBounded(map, "b", "2", 2);
    setBounded(map, "c", "3", 2);
    expect([...map.entries()]).toEqual([
      ["b", "2"],
      ["c", "3"],
    ]);
    setBounded(map, "b", "2b", 2);
    expect([...map.entries()]).toEqual([
      ["c", "3"],
      ["b", "2b"],
    ]);
  });
});

describe("composio tool mapping", () => {
  it("maps OpenAI-style session tools and raw slugs", () => {
    const tools = asConnectorTools([
      {
        type: "function",
        function: {
          name: "COMPOSIO_SEARCH_TOOLS",
          description: "Search tools",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
      },
      {
        slug: "HACKERNEWS_GET_USER",
        description: "Look up a public HN profile",
        inputParameters: { type: "object", properties: { username: { type: "string" } } },
      },
    ]);
    expect(tools.map((tool) => tool.name)).toEqual([
      "COMPOSIO_SEARCH_TOOLS",
      "HACKERNEWS_GET_USER",
    ]);
    expect(tools[1]?.inputSchema).toMatchObject({ properties: { username: { type: "string" } } });
  });

  it("redacts project keys from errors", () => {
    expect(sanitizeComposioError("denied ak_secretvaluehere")).toContain("[redacted]");
    expect(sanitizeComposioError("denied ak_secretvaluehere")).not.toContain("ak_secret");
    expect(sanitizeComposioError("COMPOSIO_API_KEY=ak_shouldnotleak")).not.toContain(
      "ak_shouldnotleak",
    );
  });

  it("paginates until the cursor ends", async () => {
    const pages = [
      { items: ["gmail", "github"], cursor: "page-2" },
      { items: ["slack"], cursor: undefined },
    ];
    const items = await collectPages(async (cursor) => {
      if (!cursor) return pages[0]!;
      return pages[1]!;
    });
    expect(items).toEqual(["gmail", "github", "slack"]);
  });

  it("treats Composio no-auth toolkit errors as in-app connect", () => {
    expect(
      isNoAuthToolkitError(
        new Error(
          '400 {"error":{"message":"Toolkit hackernews does not require authentication.","slug":"ToolRouterV2_ToolkitsIsNoAuth"}}',
        ),
      ),
    ).toBe(true);
    expect(isNoAuthToolkitError(new Error("redirect required"))).toBe(false);
  });

  it("collects nested Composio log ids", () => {
    expect(
      collectLogIds({
        logId: "",
        data: { results: [{ log_id: "log_abc123", slug: "HACKERNEWS_GET_USER" }] },
      }),
    ).toEqual(["log_abc123"]);
  });

  it("keys execute sessions by sorted unique toolkits", () => {
    expect(executeSessionKey(["hackernews", "gmail", "hackernews"])).toBe("gmail,hackernews");
    expect(executeSessionKey([])).toBe("");
  });

  it("filters the catalog by name or slug", () => {
    const items = [
      { slug: "github", name: "GitHub", logo: null, connected: false, noAuth: false },
      { slug: "hackernews", name: "Hacker News", logo: null, connected: false, noAuth: true },
    ];
    expect(filterCatalog(items, "hacker").map((item) => item.slug)).toEqual(["hackernews"]);
  });
});

describe("Composio during verify:fast", () => {
  it("does not construct a live Platform client under Vitest", () => {
    expect(process.env.VITEST).toBeTruthy();
    expect(isComposioEnabled("ck_must_not_call_live")).toBe(false);
  });
});

describe("ComposioConnector.complete", () => {
  /** Minimal stand-in for the SDK surface `complete()` touches. No network. */
  function fakeSdk(behaviour: {
    onWait: (id: string, timeout?: number) => Promise<{ id: string }>;
  }) {
    const calls: Array<{ id: string; timeout?: number }> = [];
    const sdk = {
      connectedAccounts: {
        waitForConnection: async (id: string, timeout?: number) => {
          calls.push({ id, timeout });
          return behaviour.onWait(id, timeout);
        },
      },
    };
    return { sdk: sdk as unknown as ConstructorParameters<typeof ComposioConnector>[0], calls };
  }

  const context = {
    operationId: "op",
    traceId: "trace",
    workspaceId: "ws-1",
    userId: "user-1",
    signal: new AbortController().signal,
  };

  it("waits on the stored connection request and returns the connected account id", async () => {
    const { sdk, calls } = fakeSdk({ onWait: async () => ({ id: "ca_live" }) });
    const connector = new ComposioConnector(sdk);
    await expect(
      connector.complete({ state: "ca_pending", code: "oauth-code" }, context),
    ).resolves.toEqual({ connectionRef: "ca_live" });
    // Short wait: the web and mobile callbacks poll instead of holding a request.
    expect(calls).toEqual([{ id: "ca_pending", timeout: 3_000 }]);
  });

  it("falls back to the request id when the SDK returns no id", async () => {
    const { sdk } = fakeSdk({ onWait: async () => ({ id: "" }) });
    await expect(
      new ComposioConnector(sdk).complete({ state: "ca_pending" }, context),
    ).resolves.toEqual({ connectionRef: "ca_pending" });
  });

  it("surfaces a still-pending connection as an error the caller can retry", async () => {
    const { sdk } = fakeSdk({
      onWait: async () => {
        throw new Error("Connection request timed out for ca_pending");
      },
    });
    await expect(
      new ComposioConnector(sdk).complete({ state: "ca_pending" }, context),
    ).rejects.toThrow(/timed out/);
  });

  it("refuses to call the SDK without a provider reference", async () => {
    const { sdk, calls } = fakeSdk({ onWait: async () => ({ id: "ca_live" }) });
    await expect(new ComposioConnector(sdk).complete({ state: "" }, context)).rejects.toThrow(
      /referência do provedor/,
    );
    expect(calls).toEqual([]);
  });
});

describe("composio key resolution (BYOK)", () => {
  it("prefers the env key and never asks the store", async () => {
    let asked = 0;
    const connector = new ComposioConnector({
      envApiKey: "env-key",
      loadStoredKey: async () => {
        asked += 1;
        return "stored-key";
      },
    });
    expect(await connector.resolveApiKey()).toBe("env-key");
    expect(asked).toBe(0);
  });

  it("reads the stored key, caches it briefly and forgets it on invalidate", async () => {
    let value: string | undefined = "first";
    let asked = 0;
    const connector = new ComposioConnector({
      loadStoredKey: async () => {
        asked += 1;
        return value;
      },
    });
    expect(await connector.resolveApiKey(1_000)).toBe("first");
    value = "second";
    expect(await connector.resolveApiKey(2_000)).toBe("first");
    expect(await connector.resolveApiKey(1_000 + COMPOSIO_KEY_TTL_MS)).toBe("second");
    connector.invalidateKey();
    value = undefined;
    expect(await connector.resolveApiKey(1_000 + COMPOSIO_KEY_TTL_MS)).toBeUndefined();
    expect(await connector.available()).toBe(false);
    expect(asked).toBe(4);
  });

  it("stays unavailable without any key and says what to do", async () => {
    const connector = new ComposioConnector({ loadStoredKey: async () => undefined });
    expect(await connector.available()).toBe(false);
    await expect(connector.catalog("u1")).rejects.toBeInstanceOf(ComposioKeyMissingError);
  });
});

describe("prazo das chamadas ao Composio", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const context = {
    operationId: "op",
    traceId: "trace",
    workspaceId: "ws-1",
    userId: "user-1",
    connectedProviders: ["gmail"],
    signal: new AbortController().signal,
  };

  /** SDK de mentira: nenhuma rede, e o que precisa pendurar simplesmente nunca resolve. */
  function fakeSdk(session: Record<string, unknown>) {
    const built = { sessionId: "s-1", ...session };
    return {
      sessions: { use: async () => built },
      create: async () => built,
    } as unknown as ConstructorParameters<typeof ComposioConnector>[0];
  }

  const forever = () => new Promise<never>(() => undefined);

  /** Sessão de mentira cuja lista de apps conectados responde ao que o teste mandar. */
  function session(connected: () => boolean) {
    return {
      sessionId: "s-1",
      toolkits: async () => ({
        items: connected()
          ? [
              {
                slug: "gmail",
                name: "Gmail",
                isNoAuth: false,
                connection: {
                  isActive: true,
                  connectedAccount: { id: "acc-1", status: "ACTIVE" },
                },
              },
            ]
          : [],
        cursor: undefined,
        totalPages: 1,
      }),
    };
  }

  it("entrega o valor quando o Composio responde a tempo", async () => {
    await expect(withComposioDeadline(Promise.resolve("ok"), "tools")).resolves.toBe("ok");
    await expect(withComposioDeadline(Promise.reject(new Error("boom")), "tools")).rejects.toThrow(
      /boom/,
    );
  });

  it("desiste sozinha do socket pendurado, em vez de segurar o turno", async () => {
    vi.useFakeTimers();
    const late = withComposioDeadline(forever(), "tools", { timeoutMs: 1_000 });
    const settled = expect(late).rejects.toBeInstanceOf(ComposioTimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
    const second = withComposioDeadline(forever(), "tools", { timeoutMs: 1_000 });
    const message = second.catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(message).resolves.toMatch(/demorou demais/);
  });

  it("obedece ao signal de quem chamou", async () => {
    const controller = new AbortController();
    const pending = withComposioDeadline(forever(), "execute", {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    const settled = expect(pending).rejects.toBeInstanceOf(ComposioTimeoutError);
    controller.abort();
    await settled;
    // Um signal já abortado nem chega a esperar.
    await expect(
      withComposioDeadline(forever(), "execute", { signal: controller.signal }),
    ).rejects.toBeInstanceOf(ComposioTimeoutError);
  });

  it("corta a paginação quando uma página pendura ou o orçamento acaba", async () => {
    vi.useFakeTimers();
    const hungPage = collectPages(() => forever());
    const settled = expect(hungPage).rejects.toBeInstanceOf(ComposioTimeoutError);
    await vi.advanceTimersByTimeAsync(COMPOSIO_PAGE_TIMEOUT_MS);
    await settled;

    // Páginas que sempre trazem cursor: o orçamento de parede termina a varredura.
    let pages = 0;
    const endless = collectPages<string>(async () => {
      pages += 1;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return { items: ["gmail"], cursor: `page-${pages}` };
    });
    const budget = expect(endless).rejects.toBeInstanceOf(ComposioTimeoutError);
    await vi.advanceTimersByTimeAsync(COMPOSIO_PAGES_BUDGET_MS + 1_000);
    await budget;
    expect(pages).toBeLessThanOrEqual(COMPOSIO_PAGES_BUDGET_MS / 1_000 + 1);
  });

  /** Roda a ferramenta e devolve o último evento, como o executor faz. */
  async function drainExecute(connector: ComposioConnector, executionId = "exec-1") {
    const events: ConnectorEvent[] = [];
    const done = (async () => {
      for await (const event of connector.execute(
        { tool: "GMAIL_SEND_EMAIL", args: {}, executionId },
        context,
      )) {
        events.push(event);
      }
    })();
    return { events, done };
  }

  it("execute devolve o turno sem prender o slot do worker", async () => {
    vi.useFakeTimers();
    const connector = new ComposioConnector(fakeSdk({ execute: () => forever() }));
    const { events, done } = await drainExecute(connector);
    await vi.advanceTimersByTimeAsync(COMPOSIO_REQUEST_TIMEOUT_MS);
    await done;
    expect(events.at(-1)).toMatchObject({ type: "result" });
  });

  it("mutação que estoura o prazo não é reexecutada: o resultado é DESCONHECIDO", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let seen: AbortSignal | undefined;
    const connector = new ComposioConnector(
      fakeSdk({
        execute: (
          _tool: string,
          _args: unknown,
          _options: unknown,
          requestOptions?: { signal?: AbortSignal },
        ) => {
          calls += 1;
          seen = requestOptions?.signal;
          return forever();
        },
      }),
    );
    const { events, done } = await drainExecute(connector, "exec-42");
    await vi.advanceTimersByTimeAsync(COMPOSIO_REQUEST_TIMEOUT_MS * 3);
    await done;

    // Uma tentativa, e só. Nada de mandar o mesmo e-mail de novo por conta própria.
    expect(calls).toBe(1);
    // Cancelamento real: o SDK recebe o abort (0.16 aceita `signal`).
    expect(seen?.aborted).toBe(true);
    const last = events.at(-1) as { type: string; data: unknown };
    expect(last.type).toBe("result");
    expect(isComposioUnknownOutcomeResult(last.data)).toBe(true);
    expect(last.data).toMatchObject({
      outcome: COMPOSIO_UNKNOWN_OUTCOME,
      status: "unknown",
      retry: false,
      tool: "GMAIL_SEND_EMAIL",
      executionId: "exec-42",
    });
    // Nenhum evento de erro: um erro é o que faz o modelo (e o job) tentarem de novo.
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("desconhecido é distinguível de falhou-de-verdade para quem chama", async () => {
    vi.useFakeTimers();
    // Quem chama repete só o que é seguro repetir.
    async function callWithRetry(connector: ComposioConnector) {
      let attempts = 0;
      for (let i = 0; i < 2; i += 1) {
        attempts += 1;
        const { events, done } = await drainExecute(connector);
        await vi.advanceTimersByTimeAsync(COMPOSIO_REQUEST_TIMEOUT_MS);
        await done;
        const last = events.at(-1);
        if (last?.type === "result" && isComposioUnknownOutcomeResult(last.data)) {
          return { attempts, outcome: "unknown" as const };
        }
        if (last?.type === "error") continue;
        return { attempts, outcome: "ok" as const };
      }
      return { attempts, outcome: "failed" as const };
    }

    let hungCalls = 0;
    const hung = new ComposioConnector(
      fakeSdk({
        execute: () => {
          hungCalls += 1;
          return forever();
        },
      }),
    );
    await expect(callWithRetry(hung)).resolves.toMatchObject({ attempts: 1, outcome: "unknown" });
    expect(hungCalls).toBe(1);

    // Falha de verdade (o Composio respondeu "deu erro"): repetir é decisão de quem chama.
    let brokenCalls = 0;
    const broken = new ComposioConnector(
      fakeSdk({
        execute: async () => {
          brokenCalls += 1;
          return { error: "422 argumento inválido", data: undefined };
        },
      }),
    );
    await expect(callWithRetry(broken)).resolves.toMatchObject({ outcome: "failed" });
    expect(brokenCalls).toBe(2);
  });

  it("begin não vira 'falhou': o pedido de conexão pode ter sido criado", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const connector = new ComposioConnector(
      fakeSdk({
        authorize: () => {
          calls += 1;
          return forever();
        },
      }),
    );
    const pending = connector.begin(
      { provider: "gmail", redirectUrl: "https://app.local/cb" },
      context,
    );
    const settled = expect(pending).rejects.toBeInstanceOf(ComposioUnknownOutcomeError);
    await vi.advanceTimersByTimeAsync(COMPOSIO_REQUEST_TIMEOUT_MS);
    await settled;
    expect(calls).toBe(1);
  });

  it("revoke consulta o estado antes de deixar alguém repetir", async () => {
    vi.useFakeTimers();
    // Depois do prazo, a conta sumiu: a revogação aconteceu, ninguém repete nada.
    let listed = 0;
    const onlyFirstLookup = () => {
      listed += 1;
      return listed === 1;
    };
    const gone = new ComposioConnector({
      sessions: { use: async () => session(onlyFirstLookup) },
      create: async () => session(onlyFirstLookup),
      connectedAccounts: { delete: () => forever() },
    } as unknown as ConstructorParameters<typeof ComposioConnector>[0]);
    const revoked = gone.revoke("gmail", context);
    const revokedOk = expect(revoked).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(COMPOSIO_REQUEST_TIMEOUT_MS);
    await revokedOk;

    // Continua conectada: repetir um delete leva ao mesmo fim, então é timeout comum.
    const stuck = new ComposioConnector({
      sessions: { use: async () => session(() => true) },
      create: async () => session(() => true),
      connectedAccounts: { delete: () => forever() },
    } as unknown as ConstructorParameters<typeof ComposioConnector>[0]);
    const pending = stuck.revoke("gmail", context);
    const settled = expect(pending).rejects.toBeInstanceOf(ComposioTimeoutError);
    await vi.advanceTimersByTimeAsync(COMPOSIO_REQUEST_TIMEOUT_MS);
    await settled;
  });

  it("discoverTools e connectionReady também têm prazo", async () => {
    vi.useFakeTimers();
    const connector = new ComposioConnector(
      fakeSdk({ tools: () => forever(), toolkits: () => forever() }),
    );
    const tools = connector.discoverTools(context);
    const toolsSettled = expect(tools).rejects.toBeInstanceOf(ComposioTimeoutError);
    await vi.advanceTimersByTimeAsync(COMPOSIO_REQUEST_TIMEOUT_MS);
    await toolsSettled;

    const ready = connector.connectionReady("user-1", "gmail");
    const readySettled = expect(ready).rejects.toBeInstanceOf(ComposioTimeoutError);
    await vi.advanceTimersByTimeAsync(COMPOSIO_REQUEST_TIMEOUT_MS);
    await readySettled;
  });

  it("uma sessão pendurada não vira espera infinita", async () => {
    vi.useFakeTimers();
    const connector = new ComposioConnector({
      sessions: { use: async () => forever() },
      create: () => forever(),
    } as unknown as ConstructorParameters<typeof ComposioConnector>[0]);
    const pending = connector.sessionFor("user-1");
    const settled = expect(pending).rejects.toBeInstanceOf(ComposioTimeoutError);
    await vi.advanceTimersByTimeAsync(COMPOSIO_REQUEST_TIMEOUT_MS);
    await settled;
  });
});
