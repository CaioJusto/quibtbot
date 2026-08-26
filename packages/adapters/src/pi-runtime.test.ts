import type { Agent } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AgentRuntimeEvent } from "@quibt/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { APPROVAL_WAIT_TEXT, ApprovalPause } from "./approval-wait.js";
import {
  LLM_MAX_RETRIES,
  LLM_MAX_RETRY_DELAY_MS,
  LLM_TIMEOUT_MS,
  PROVIDER_STALLED_MESSAGE,
} from "./llm-retry.js";
import { PEER_WAIT_TEXT, PeerPause } from "./peer-wait.js";
import {
  enqueueRuntimeEvent,
  PiAgentRuntime,
  type PiAgentRuntimeOptions,
  type ToolHost,
  toAgentTool,
  userFacingError,
  watchIdle,
} from "./pi-runtime.js";

const catalog = builtinModels();

type Reply =
  | { text: string }
  | { toolCall: { id: string; name: string; arguments: Record<string, unknown> } }
  | { hang: true };

function assistantMessage(model: Model<never>, content: AssistantMessage["content"]) {
  return {
    role: "assistant" as const,
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 3,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  } satisfies AssistantMessage;
}

/** O que o Agent consome de um stream do pi-ai: os eventos e a mensagem final. */
function fakeStream() {
  const queue: AssistantMessageEvent[] = [];
  let wake: (() => void) | undefined;
  let final: ((message: AssistantMessage) => void) | undefined;
  const result = new Promise<AssistantMessage>((resolve) => {
    final = resolve;
  });
  let ended = false;
  return {
    push(event: AssistantMessageEvent) {
      queue.push(event);
      if (event.type === "done") {
        ended = true;
        final?.(event.message);
      }
      if (event.type === "error") {
        ended = true;
        final?.(event.error);
      }
      wake?.();
    },
    result: () => result,
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length) {
          const next = queue.shift()!;
          yield next;
          if (next.type === "done" || next.type === "error") return;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

/**
 * Uma coleção de modelos com o catálogo real e um `streamSimple` roteirizado: cada chamada
 * consome a próxima resposta. `hang` emite o começo e fica mudo até o signal abortar.
 */
function scriptedModels(replies: Reply[]) {
  const calls: Array<SimpleStreamOptions | undefined> = [];
  const streamSimple = vi.fn(
    (model: Model<never>, _ctx: unknown, options?: SimpleStreamOptions) => {
      calls.push(options);
      const stream = fakeStream();
      const reply = replies.shift() ?? { text: "acabou o roteiro" };
      const partial = { ...assistantMessage(model, []), stopReason: "pending" as const };
      stream.push({ type: "start", partial });
      if ("hang" in reply) {
        options?.signal?.addEventListener("abort", () => {
          stream.push({
            type: "error",
            reason: "aborted",
            error: {
              ...assistantMessage(model, []),
              stopReason: "aborted",
              errorMessage: "Request aborted",
            },
          });
        });
        return stream;
      }
      if ("toolCall" in reply) {
        stream.push({
          type: "done",
          reason: "toolUse",
          message: {
            ...assistantMessage(model, [{ type: "toolCall", ...reply.toolCall }]),
            stopReason: "toolUse",
          },
        });
        return stream;
      }
      stream.push({ type: "text_delta", contentIndex: 0, delta: reply.text, partial });
      stream.push({
        type: "done",
        reason: "stop",
        message: assistantMessage(model, [{ type: "text", text: reply.text }]),
      });
      return stream;
    },
  );
  const models = {
    getModel: (provider: string, id: string) => catalog.getModel(provider, id),
    streamSimple,
  };
  const modelsForRun: PiAgentRuntimeOptions["modelsForRun"] = () => models as never;
  return { modelsForRun, streamSimple, calls };
}

async function collect(
  runtime: PiAgentRuntime,
  model: { apiKey?: string; oauthCredential?: string },
) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of runtime.run(
    {
      botId: "b",
      threadId: "t",
      runId: `r-${Math.random().toString(36).slice(2)}`,
      prompt: "oi",
      instructions: "teste",
      history: [],
      tools: [],
      model: { provider: "openrouter", id: "openai/gpt-4o-mini", ...model },
      executeTool: async () => ({ ok: true }),
    },
    {
      operationId: "1",
      traceId: "1",
      workspaceId: "w",
      userId: "u",
      signal: new AbortController().signal,
    },
  )) {
    events.push(event);
  }
  return events;
}

describe("runtime event queue", () => {
  it("coalesces consecutive text deltas", () => {
    const items: Array<{ type: "text"; text: string } | { type: "done" }> = [];
    enqueueRuntimeEvent(items, { type: "text", text: "hel" });
    enqueueRuntimeEvent(items, { type: "text", text: "lo" });
    enqueueRuntimeEvent(items, { type: "done" });
    enqueueRuntimeEvent(items, { type: "text", text: "!" });
    expect(items).toEqual([
      { type: "text", text: "hello" },
      { type: "done" },
      { type: "text", text: "!" },
    ]);
  });
});

describe("provider errors", () => {
  it("turns xAI spending-limit failures into an actionable Portuguese message", () => {
    expect(
      userFacingError(
        'OpenAI API error (402): 402 "You have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage or upgrade at https://grok.com/supergrok."',
      ),
    ).toBe(
      "A xAI recusou este pedido porque a conta conectada está sem créditos ou sem uma assinatura Grok válida. Conecte outra assinatura ou chave, ou libere a cota no Grok, e me chame de novo. Toque em Conectar modelo, ou vá em Conta → Modelo.",
    );
  });
});

describe("Pi agent runtime", () => {
  it("reports an unknown model without calling a provider", async () => {
    const runtime = new PiAgentRuntime();
    const events: string[] = [];
    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "r",
        prompt: "hi",
        instructions: "test",
        history: [],
        tools: [],
        model: { provider: "openrouter", id: "not-a-real-model-xyz" },
      },
      {
        operationId: "1",
        traceId: "1",
        workspaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      if (event.type === "text") events.push(event.text);
    }
    expect(events.join(" ")).toMatch(/Unknown model/i);
  });

  it("stops before calling the model when the executor's signal is already aborted", async () => {
    const runtime = new PiAgentRuntime();
    const controller = new AbortController();
    controller.abort();
    const events: Array<{ type: string; text?: string }> = [];
    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "r-aborted",
        prompt: "hi",
        instructions: "test",
        history: [],
        tools: [],
        model: { provider: "openrouter", id: "openai/gpt-4o-mini" },
      },
      {
        operationId: "1",
        traceId: "1",
        workspaceId: "w",
        userId: "u",
        signal: controller.signal,
      },
    )) {
      events.push(event);
    }
    expect(events).toEqual([{ type: "done", text: "stopped" }]);
  });

  it("ends the turn instead of feeding the model an error when a tool pauses for approval", async () => {
    const executeTool = vi.fn().mockRejectedValue(new ApprovalPause());
    const pushed: unknown[] = [];
    const host = {
      queue: { push: (event: unknown) => pushed.push(event) },
      request: { runId: "r", executeTool },
      signal: new AbortController().signal,
      depth: 0,
    } as unknown as ToolHost;
    const tool = toAgentTool(
      {
        name: "shell",
        description: "run",
        inputSchema: { type: "object", properties: {} },
      },
      host,
    );
    const result = await tool.execute("call-1", { command: "ls" }, host.signal, () => undefined);
    expect(result.terminate).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: APPROVAL_WAIT_TEXT }]);
    expect(executeTool).toHaveBeenCalledWith("shell", { command: "ls" }, "r:call-1");

    executeTool.mockRejectedValueOnce(new Error("boom"));
    await expect(
      tool.execute("call-2", { command: "ls" }, host.signal, () => undefined),
    ).rejects.toThrow("boom");
  });

  it.each(["request_takeover", "run_subagent"])(
    "does not perform the native %s effect before executor approval",
    async (name) => {
      const executeTool = vi.fn().mockRejectedValue(new ApprovalPause());
      const pushed: Array<{ type?: string }> = [];
      const host = {
        queue: { push: (event: { type?: string }) => pushed.push(event) },
        request: { runId: "r-native", executeTool },
        signal: new AbortController().signal,
        depth: 0,
      } as unknown as ToolHost;
      const tool = toAgentTool(
        {
          name,
          description: "native",
          inputSchema: { type: "object", properties: {} },
        },
        host,
      );
      const result = await tool.execute(
        "call-native",
        name === "run_subagent" ? { task: "work" } : { reason: "login" },
        host.signal,
        () => undefined,
      );
      expect(result.terminate).toBe(true);
      expect(executeTool).toHaveBeenCalledOnce();
      expect(pushed.map((event) => event.type)).toEqual(["tool"]);
    },
  );

  it("tells the truth when the pause is waiting for a teammate, not for the user", async () => {
    const executeTool = vi.fn().mockRejectedValue(new PeerPause());
    const host = {
      queue: { push: () => undefined },
      request: { runId: "r", executeTool },
      signal: new AbortController().signal,
      depth: 0,
    } as unknown as ToolHost;
    const tool = toAgentTool(
      {
        name: "ask_bot",
        description: "ask",
        inputSchema: { type: "object", properties: {} },
      },
      host,
    );
    const result = await tool.execute("call-1", { message: "e ai?" }, host.signal, () => undefined);
    expect(result.terminate).toBe(true);
    expect(result.details).toMatchObject({ paused: true });
    expect(result.content).toEqual([{ type: "text", text: PEER_WAIT_TEXT }]);
    expect(PEER_WAIT_TEXT).not.toBe(APPROVAL_WAIT_TEXT);
  });

  it("does not reuse one execution id when the provider sends no tool-call id", async () => {
    const executeTool = vi.fn(async () => ({ ok: true }));
    const host = {
      queue: { push: () => undefined },
      request: { runId: "r", executeTool },
      signal: new AbortController().signal,
      depth: 0,
      calls: { count: 0 },
    } as unknown as ToolHost;
    const tool = toAgentTool(
      {
        name: "shell",
        description: "run",
        inputSchema: { type: "object", properties: {} },
      },
      host,
    );
    await tool.execute("", { command: "ls" }, host.signal, () => undefined);
    await tool.execute("", { command: "pwd" }, host.signal, () => undefined);
    const ids = executeTool.mock.calls.map((call) => String((call as unknown as string[])[2]));
    // Sharing a key makes the effect ledger answer the second command with the first result.
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id.startsWith("r:shell"))).toBe(true);
  });
});

describe("chamadas ao provedor", () => {
  it("manda retry e timeout em toda chamada ao modelo", async () => {
    const fake = scriptedModels([{ text: "olá" }]);
    const events = await collect(new PiAgentRuntime({ modelsForRun: fake.modelsForRun }), {
      apiKey: "sk-or-v1-abc",
    });
    expect(fake.streamSimple).toHaveBeenCalledOnce();
    expect(fake.calls[0]).toMatchObject({
      maxRetries: LLM_MAX_RETRIES,
      maxRetryDelayMs: LLM_MAX_RETRY_DELAY_MS,
      timeoutMs: LLM_TIMEOUT_MS,
      apiKey: "sk-or-v1-abc",
    });
    expect(fake.calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(events).toContainEqual({ type: "text", text: "olá" });
    expect(events.at(-1)).toEqual({ type: "done", text: "olá" });
  });

  it("aborta um provedor mudo e pede ao executor para tentar de novo", async () => {
    const fake = scriptedModels([{ hang: true }]);
    const events = await collect(
      new PiAgentRuntime({ modelsForRun: fake.modelsForRun, idleTimeoutMs: 40 }),
      { apiKey: "sk-or-v1-abc" },
    );
    expect(fake.calls[0]?.signal?.aborted).toBe(true);
    expect(events).toContainEqual({
      type: "error",
      message: PROVIDER_STALLED_MESSAGE,
      retryable: true,
    });
    expect(events.at(-1)).toEqual({ type: "done", text: PROVIDER_STALLED_MESSAGE });
    expect(events.some((event) => event.type === "text")).toBe(false);
  });

  it("classifica um 429 do provedor como retryable, mas não um cancelamento", async () => {
    const runtime = new PiAgentRuntime({
      modelsForRun: () =>
        ({
          getModel: (provider: string, id: string) => catalog.getModel(provider, id),
          streamSimple: () => {
            throw new Error("429 Too Many Requests: rate limit exceeded");
          },
        }) as never,
    });
    const events = await collect(runtime, { apiKey: "sk-or-v1-abc" });
    const error = events.find((event) => event.type === "error");
    expect(error).toMatchObject({ retryable: true });
    expect(error && "message" in error ? error.message : "").toMatch(/^Não consegui concluir: 429/);
  });

  it("o subagente usa a coleção do run e nunca recebe o token cru de uma assinatura", async () => {
    const fake = scriptedModels([
      {
        toolCall: {
          id: "call-1",
          name: "run_subagent",
          arguments: { name: "ajudante", task: "conta até 3" },
        },
      },
      { text: "1 2 3" },
      { text: "pronto" },
    ]);
    const events = await collect(new PiAgentRuntime({ modelsForRun: fake.modelsForRun }), {
      apiKey: "sk-or-v1-cru",
      oauthCredential: JSON.stringify({ type: "oauth", access: "tok", refresh: "r", expires: 0 }),
    });
    // Pai, subagente e pai de novo — todos na mesma coleção, todos sem chave por cima.
    expect(fake.streamSimple).toHaveBeenCalledTimes(3);
    expect(fake.calls.map((call) => call?.apiKey)).toEqual([undefined, undefined, undefined]);
    expect(fake.calls.every((call) => call?.maxRetries === LLM_MAX_RETRIES)).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "subagent", status: "completed", result: "1 2 3" }),
    );
    expect(events.at(-1)).toEqual({ type: "done", text: "pronto" });
    expect(JSON.stringify(fake.calls)).not.toContain("sk-or-v1-cru");
  });
});

describe("watchIdle", () => {
  function fakeAgent() {
    const listeners: Array<(event: { type: string }) => void> = [];
    return {
      agent: {
        subscribe: (listener: (event: { type: string }) => void) => {
          listeners.push(listener);
          return () => listeners.splice(listeners.indexOf(listener), 1);
        },
      } as unknown as Agent,
      emit: (type: string) => {
        for (const listener of listeners) listener({ type });
      },
    };
  }

  it("dispara só depois de um silêncio inteiro, e não enquanto uma ferramenta roda", () => {
    vi.useFakeTimers();
    try {
      const { agent, emit } = fakeAgent();
      const onIdle = vi.fn();
      const stop = watchIdle(agent, 100, onIdle);
      vi.advanceTimersByTime(80);
      emit("message_update");
      vi.advanceTimersByTime(80);
      expect(onIdle).not.toHaveBeenCalled();
      emit("tool_execution_start");
      vi.advanceTimersByTime(1000);
      expect(onIdle).not.toHaveBeenCalled();
      emit("tool_execution_end");
      vi.advanceTimersByTime(100);
      expect(onIdle).toHaveBeenCalledOnce();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("parar o vigia cancela o relógio", () => {
    vi.useFakeTimers();
    try {
      const { agent } = fakeAgent();
      const onIdle = vi.fn();
      watchIdle(agent, 50, onIdle)();
      vi.advanceTimersByTime(200);
      expect(onIdle).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("toHistory", () => {
  it("manda o que o bot disse como fala do assistente, sem rótulo 'Assistant:'", async () => {
    const { toHistory } = await import("./pi-runtime.js");
    const history = toHistory(
      [
        { role: "user", content: "oi" },
        { role: "assistant", content: "olá!" },
        { role: "user", content: "e aí?" },
      ] as never,
      "e aí?",
      {
        api: "openai-completions",
        provider: "openrouter",
        id: "deepseek/deepseek-chat",
      },
    );
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ role: "user", content: "oi" });
    expect(history[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "olá!" }],
      stopReason: "stop",
    });
    expect(JSON.stringify(history)).not.toContain("Assistant:");
  });
});

describe("modelo local (ollama / openai-compatible)", () => {
  async function collectLocal(runtime: PiAgentRuntime, signal?: AbortSignal) {
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: `local-${Math.random().toString(36).slice(2)}`,
        prompt: "oi",
        instructions: "teste",
        history: [],
        tools: [],
        model: { provider: "ollama", id: "llama3.2", apiKey: "http://127.0.0.1:11434/v1" },
        executeTool: async () => ({ ok: true }),
      },
      {
        operationId: "1",
        traceId: "1",
        workspaceId: "w",
        userId: "u",
        signal: signal ?? new AbortController().signal,
      },
    )) {
      events.push(event);
    }
    return events;
  }

  it("desiste de um Ollama mudo em vez de deixar o bot em Trabalhando… para sempre", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    try {
      const events = await collectLocal(new PiAgentRuntime({ idleTimeoutMs: 30 }));
      expect(events).toContainEqual({
        type: "error",
        message: PROVIDER_STALLED_MESSAGE,
        retryable: true,
      });
      expect(events.at(-1)).toEqual({ type: "done", text: PROVIDER_STALLED_MESSAGE });
      // O fetch pendurado é cortado junto: o LM Studio não fica com a chamada aberta.
      expect(fetchSpy.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("trata um 503 do modelo local como erro passageiro, não como resposta do bot", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 503 }));
    try {
      const events = await collectLocal(new PiAgentRuntime({}));
      expect(events[0]).toMatchObject({ type: "error", retryable: true });
      expect(events.some((event) => event.type === "text")).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("responde normalmente quando o modelo local responde", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "olá do Ollama" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      const events = await collectLocal(new PiAgentRuntime({}));
      expect(events).toEqual([{ type: "text", text: "olá do Ollama" }, { type: "done" }]);
      expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://127.0.0.1:11434/v1/chat/completions");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
