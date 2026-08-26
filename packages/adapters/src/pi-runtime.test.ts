import { describe, expect, it, vi } from "vitest";
import { APPROVAL_WAIT_TEXT, ApprovalPause } from "./approval-wait.js";
import { PEER_WAIT_TEXT, PeerPause } from "./peer-wait.js";
import {
  enqueueRuntimeEvent,
  PiAgentRuntime,
  type ToolHost,
  toAgentTool,
  userFacingError,
} from "./pi-runtime.js";

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
