import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterContext, AgentRunRequest, AgentRuntime } from "@quibt/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cliEnvironment, LocalCliAgentRuntime, RoutedAgentRuntime } from "./local-cli-runtime.js";

const created: string[] = [];

async function fakeCli(name: "claude" | "codex" | "grok", lines: string[]) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "quibt-cli-runtime-test-"));
  created.push(dir);
  const executable = path.join(dir, name);
  const body = [
    "#!/bin/sh",
    "cat >/dev/null || true",
    ...lines.map((line) => `printf '%s\\n' '${line}'`),
  ].join("\n");
  await writeFile(executable, `${body}\n`, "utf8");
  await chmod(executable, 0o755);
  return { dir, executable };
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const context: AdapterContext = {
  operationId: "op",
  traceId: "trace",
  workspaceId: "ws",
  userId: "user",
  signal: new AbortController().signal,
};

function request(id: string, provider = "local-cli"): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: `run-${id}`,
    prompt: "Responda em duas partes.",
    instructions: "Você é útil.",
    history: [{ role: "user", content: "Contexto anterior" }],
    tools: [],
    model: { provider, id, apiKey: `local-cli:${id}` },
  };
}

async function collect(runtime: AgentRuntime, input: AgentRunRequest) {
  const events = [];
  for await (const event of runtime.run(input, context)) events.push(event);
  return events;
}

describe("LocalCliAgentRuntime", () => {
  it("does not pass API keys or deployment secrets into the host CLI process", () => {
    expect(
      cliEnvironment({
        PATH: "/bin",
        HOME: "/home/test",
        OPENAI_API_KEY: "not-for-the-cli",
        ANTHROPIC_API_KEY: "not-for-the-cli",
        DATABASE_URL: "postgres://secret",
        ENCRYPTION_KEY: "secret",
        CODEX_HOME: "/home/test/.codex",
      }),
    ).toEqual({ PATH: "/bin", HOME: "/home/test", CODEX_HOME: "/home/test/.codex" });
  });

  it("streams a scripted Claude reply through the standard runtime events", async () => {
    const { executable } = await fakeCli("claude", [
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Olá " } },
      }),
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "mundo" } },
      }),
      JSON.stringify({
        type: "result",
        result: "Olá mundo",
        usage: { input_tokens: 4, output_tokens: 2 },
      }),
    ]);
    const runtime = new LocalCliAgentRuntime({ resolveBinary: async () => executable });

    const events = await collect(runtime, request("claude"));

    expect(events.filter((event) => event.type === "text").map((event) => event.text)).toEqual([
      "Olá ",
      "mundo",
    ]);
    expect(events).toContainEqual({
      type: "usage",
      inputTokens: 4,
      outputTokens: 2,
      provider: "local-cli",
      model: "claude",
    });
    expect(events.at(-1)).toEqual({ type: "done", text: "Olá mundo" });
  });

  it("parses Codex JSONL and Grok incremental JSON without a network or real login", async () => {
    const codex = await fakeCli("codex", [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Codex ok" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2 } }),
    ]);
    const grok = await fakeCli("grok", [
      JSON.stringify({ type: "text", data: "Grok " }),
      JSON.stringify({ type: "text", data: "ok" }),
      JSON.stringify({ type: "end", usage: { input_tokens: 3, output_tokens: 2 } }),
    ]);

    const codexEvents = await collect(
      new LocalCliAgentRuntime({ resolveBinary: async () => codex.executable }),
      request("codex"),
    );
    const grokEvents = await collect(
      new LocalCliAgentRuntime({ resolveBinary: async () => grok.executable }),
      request("grok"),
    );

    expect(codexEvents.at(-1)).toEqual({ type: "done", text: "Codex ok" });
    expect(grokEvents.at(-1)).toEqual({ type: "done", text: "Grok ok" });
  });

  it("refuses unknown model ids without resolving or spawning them", async () => {
    const resolveBinary = vi.fn(async () => "/bin/false");
    const events = await collect(new LocalCliAgentRuntime({ resolveBinary }), request("bash"));
    expect(resolveBinary).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({ type: "error", message: expect.stringContaining("desconhecida") }),
    );
  });
});

describe("RoutedAgentRuntime", () => {
  it("keeps every non-CLI/Pi provider on the existing primary runtime", async () => {
    const primaryRun = vi.fn(async function* () {
      yield { type: "text" as const, text: "pi provider intact" };
      yield { type: "done" as const, text: "pi provider intact" };
    });
    const primary: AgentRuntime = {
      describe: () => ({
        id: "pi",
        contractVersion: "1",
        adapterVersion: "test",
        capabilities: { streaming: true, compaction: true, tools: true, scripted: false },
      }),
      abort: vi.fn(async () => undefined),
      run: primaryRun,
    };
    const local: AgentRuntime = {
      ...primary,
      run: vi.fn(async function* () {
        yield { type: "done" as const, text: "local" };
      }),
    };
    const runtime = new RoutedAgentRuntime(primary, local);

    const events = await collect(runtime, request("openai/gpt-4o", "openrouter"));

    expect(events.at(-1)).toEqual({ type: "done", text: "pi provider intact" });
    expect(primaryRun).toHaveBeenCalledOnce();
    expect(local.run).not.toHaveBeenCalled();
  });
});
