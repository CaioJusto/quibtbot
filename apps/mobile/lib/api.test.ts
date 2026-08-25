import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveSessionToken = vi.fn();
const tokenFromAuthResponse = vi.fn();
const clearEnrollmentToken = vi.fn();
const loadEnrollmentToken = vi.fn();

vi.mock("./session", () => ({
  clearSessionToken: vi.fn(),
  loadSessionToken: vi.fn(),
  saveSessionToken,
  tokenFromAuthResponse,
}));

vi.mock("./enrollment-store", () => ({
  clearEnrollmentToken,
  isTerminalEnrollmentSignupFailure: (status: number) => status === 403 || status === 409,
  loadEnrollmentToken,
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

beforeEach(() => {
  loadEnrollmentToken.mockResolvedValue("");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  saveSessionToken.mockReset();
  tokenFromAuthResponse.mockReset();
  clearEnrollmentToken.mockReset();
  loadEnrollmentToken.mockReset();
  loadEnrollmentToken.mockResolvedValue("");
});

describe("mobile auth API", () => {
  it("signs up and stores the session token", async () => {
    tokenFromAuthResponse.mockReturnValue("session-token");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "session-token" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { signUp } = await import("./api");
    await signUp({ name: "Ada", email: "ada@example.com", password: "password1" });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/auth\/sign-up\/email$/),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "Ada",
          email: "ada@example.com",
          password: "password1",
        }),
      }),
    );
    expect(saveSessionToken).toHaveBeenCalledWith("session-token");
  });

  it("surfaces the server message when sign-up fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ message: "Este e-mail não pode criar conta" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { signUp } = await import("./api");
    await expect(
      signUp({ name: "Ada", email: "blocked@example.com", password: "password1" }),
    ).rejects.toThrow("Este e-mail não pode criar conta");
  });

  it("sends enrollment header for first-owner signup and clears it after success", async () => {
    loadEnrollmentToken.mockResolvedValue("enroll-token");
    tokenFromAuthResponse.mockReturnValue("session-token");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "session-token" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { signUp } = await import("./api");
    await signUp({ name: "Owner", email: "owner@example.com", password: "password1" });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/auth\/sign-up\/email$/),
      expect.objectContaining({
        headers: expect.objectContaining({ "x-quibt-enrollment": "enroll-token" }),
      }),
    );
    expect(clearEnrollmentToken).toHaveBeenCalledOnce();
  });

  it("clears enrollment after a terminal first-owner signup failure", async () => {
    loadEnrollmentToken.mockResolvedValue("stale-token");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ message: "Convite de proprietário expirado ou já usado." }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { signUp } = await import("./api");
    await expect(
      signUp({ name: "Owner", email: "owner@example.com", password: "password1" }),
    ).rejects.toThrow("Convite de proprietário expirado ou já usado.");
    expect(clearEnrollmentToken).toHaveBeenCalledOnce();
  });
});

describe("mobile rpc", () => {
  it("preserves structured oRPC error data from the serialized JSON envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({
          json: {
            defined: false,
            code: "FORBIDDEN",
            status: 403,
            message: "Limite de bots atingido",
            data: { code: "plan_limit" },
          },
        }),
      }),
    );
    const { rpc } = await import("./api");
    const error = await rpc("bots/create").catch((caught) => caught);
    expect(error).toMatchObject({
      message: "Limite de bots atingido",
      code: "plan_limit",
      data: { code: "plan_limit" },
    });
  });

  it("turns a stalled request into an actionable timeout error", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      }),
    );
    const { MOBILE_REQUEST_TIMEOUT_MS, rpc } = await import("./api");
    const request = rpc("me");
    const assertion = expect(request).rejects.toThrow("A conexão demorou demais");
    await vi.advanceTimersByTimeAsync(MOBILE_REQUEST_TIMEOUT_MS);
    await assertion;
  });

  it("lets startup cancel an RPC before the regular request timeout", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          markStarted?.();
          init.signal?.addEventListener("abort", () => reject(new Error("aborted by startup")), {
            once: true,
          });
        });
      }),
    );
    const { rpc } = await import("./api");
    const controller = new AbortController();
    const request = rpc("bots/list", {}, { signal: controller.signal });

    await started;
    controller.abort();

    await expect(request).rejects.toThrow("aborted by startup");
  });

  it("tags a 401 so the screen can stop retrying and go to the login", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({}),
      }),
    );
    const { isSessionExpiredError, rpc, SESSION_EXPIRED_MESSAGE } = await import("./api");
    const error = await rpc("threads/get").catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(SESSION_EXPIRED_MESSAGE);
    expect(isSessionExpiredError(error)).toBe(true);
    // A plain network failure must not look like an expired session.
    expect(isSessionExpiredError(new Error("Network request failed"))).toBe(false);
  });

  it("retries a dropped request once and then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network request failed"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ json: { id: "me" } }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const { MOBILE_RPC_RETRY_DELAY_MS, rpc } = await import("./api");
    const request = rpc("me");
    await vi.advanceTimersByTimeAsync(MOBILE_RPC_RETRY_DELAY_MS);
    await expect(request).resolves.toEqual({ id: "me" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 502 and then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ json: { ok: true } }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const { MOBILE_RPC_RETRY_DELAY_MS, rpc } = await import("./api");
    const request = rpc("me");
    await vi.advanceTimersByTimeAsync(MOBILE_RPC_RETRY_DELAY_MS);
    await expect(request).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports an HTTP failure even when an intermediary returns non-JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error("not json");
        },
      }),
    );
    const { rpc } = await import("./api");
    await expect(rpc("me")).rejects.toThrow("rpc me failed");
  });
});

describe("mobile thread streaming", () => {
  it("streams events through expo/fetch and stops when the screen aborts", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      ":\n\n",
      'event: message\ndata: {"json":{"type":"thread.progress","runId":"run-1","payload":{"text":"Oi"}}}\n\n',
      'event: message\ndata: {"json":{"type":"thread.message.cre',
      'ated","seq":4,"payload":{"messageId":"m-1","role":"bot","blocks":[]}}}\n\n',
    ];
    let pull = 0;
    const seenInit: RequestInit[] = [];
    const expoFetch = vi.fn((_url: string, init: RequestInit) => {
      seenInit.push(init);
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = chunks[pull++];
          if (next) controller.enqueue(encoder.encode(next));
          // Keep the stream open like a live SSE connection until it is cancelled.
        },
      });
      return Promise.resolve({ ok: true, status: 200, body });
    });
    vi.doMock("expo/fetch", () => ({ fetch: expoFetch }));
    vi.stubGlobal("fetch", vi.fn());
    const { subscribeThread } = await import("./api");

    const events: Array<{ type: string }> = [];
    const abort = new AbortController();
    const done = subscribeThread(
      "bot-1",
      3,
      (event) => {
        events.push(event);
        if (events.length === 2) abort.abort();
      },
      abort.signal,
    );
    await done;

    expect(fetch).not.toHaveBeenCalled();
    expect(expoFetch).toHaveBeenCalledOnce();
    expect(seenInit[0]?.body).toBe(JSON.stringify({ json: { botId: "bot-1", cursor: 3 } }));
    expect(events.map((event) => event.type)).toEqual([
      "thread.progress",
      "thread.message.created",
    ]);
    vi.doUnmock("expo/fetch");
  });

  it("tags a 401 on the event stream so the feed stops reconnecting", async () => {
    vi.resetModules();
    vi.doMock("expo/fetch", () => {
      throw new Error("native module missing");
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const { isSessionExpiredError, subscribeThread } = await import("./api");
    const error = await subscribeThread(
      "bot-1",
      -1,
      () => undefined,
      new AbortController().signal,
    ).catch((caught) => caught);
    expect(isSessionExpiredError(error)).toBe(true);
    vi.doUnmock("expo/fetch");
  });

  it("falls back to the global fetch when expo/fetch is unavailable", async () => {
    vi.resetModules();
    vi.doMock("expo/fetch", () => {
      throw new Error("native module missing");
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, body });
    vi.stubGlobal("fetch", fetchMock);
    const { subscribeThread } = await import("./api");
    await subscribeThread("bot-1", -1, () => undefined, new AbortController().signal);
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.doUnmock("expo/fetch");
  });
});

describe("applyMobileThreadEvent", () => {
  it("replaces the optimistic row by nonce as soon as the durable live event arrives", async () => {
    const { applyMobileThreadEvent } = await import("./api");
    const next = applyMobileThreadEvent(
      {
        cursor: 3,
        messages: [
          {
            id: "optimistic:nonce-1",
            clientNonce: "nonce-1",
            role: "user" as const,
            blocks: [{ kind: "text", text: "oi" }],
          },
        ],
      },
      {
        id: "event-4",
        seq: 4,
        type: "thread.message.created",
        payload: {
          messageId: "message-1",
          clientNonce: "nonce-1",
          role: "user",
          blocks: [{ kind: "text", text: "oi" }],
        },
      },
    );
    expect(next?.cursor).toBe(4);
    expect(next?.messages.map((message) => message.id)).toEqual(["message-1"]);
  });

  it("drops streaming progress when the run ends", async () => {
    const { applyMobileThreadEvent } = await import("./api");
    const prev = {
      messages: [
        {
          id: "progress:run-1",
          role: "bot" as const,
          blocks: [{ kind: "progress" as const, text: "…" }],
          runId: "run-1",
        },
      ],
      run: { status: "running" },
    };
    expect(applyMobileThreadEvent(prev, { type: "run.completed" })).toEqual({
      messages: [],
      run: null,
    });
  });

  it("clears loaded history when another client clears the thread", async () => {
    const { applyMobileThreadEvent } = await import("./api");
    const prev = {
      messages: [
        {
          id: "message-1",
          role: "user" as const,
          blocks: [{ kind: "text" as const, text: "old" }],
        },
      ],
      run: { status: "running" },
    };
    expect(applyMobileThreadEvent(prev, { type: "thread.cleared" })).toEqual({
      messages: [],
      run: null,
    });
  });
});

describe("askText", () => {
  it("shows what the bot wants to run, and what was decided", async () => {
    const { askText, blockText } = await import("./api");
    const pending = {
      kind: "ask",
      text: "Preciso da sua aprovação",
      tool: "shell",
      detail: "xdg-open https://g1.globo.com",
    };
    expect(askText(pending)).toBe("Preciso da sua aprovação\n`xdg-open https://g1.globo.com`");
    expect(askText({ ...pending, answered: "allow" })).toContain("Permitido");
    expect(askText({ ...pending, answered: "deny" })).toContain("Recusado");
    expect(askText({ ...pending, answered: "always" })).toContain("Sempre permitido");
    expect(blockText({ id: "m", role: "bot", blocks: [pending], runId: "r" } as never)).toContain(
      "`xdg-open https://g1.globo.com`",
    );
  });
});
