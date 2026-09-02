import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterContext, AgentRunRequest, AgentRuntime } from "@quibt/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { EXTRA_ACP_CLI_ID } from "./local-cli.js";
import { cliEnvironment, LocalCliAgentRuntime, RoutedAgentRuntime } from "./local-cli-runtime.js";
import { decideToolPermission, PermissionRequiredError } from "./permissions.js";

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

function request(
  id: string,
  provider = "local-cli",
  extras: Partial<AgentRunRequest> = {},
): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: `run-${id}`,
    prompt: "Responda em duas partes.",
    instructions: "Você é útil.",
    history: [{ role: "user", content: "Contexto anterior" }],
    tools: [],
    model: { provider, id, apiKey: `local-cli:${id}` },
    ...extras,
  };
}

const shellTool = builtinAgentTools.find((tool) => tool.name === "shell")!;
const computerTool = builtinAgentTools.find((tool) => tool.name === "computer")!;

async function fakeMcpCli(
  name: "claude" | "codex" | "grok",
  tool: string,
  args: Record<string, unknown>,
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "quibt-cli-mcp-test-"));
  created.push(dir);
  const executable = path.join(dir, name);
  const body = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const tool = ${JSON.stringify(tool)};
const args = ${JSON.stringify(args)};
const configIdx = process.argv.indexOf("--mcp-config");
if (configIdx < 0) {
  process.stderr.write("missing --mcp-config\\n");
  process.exit(2);
}
const config = JSON.parse(readFileSync(process.argv[configIdx + 1], "utf8"));
const server = Object.values(config.mcpServers ?? {})[0];
if (!server || typeof server !== "object" || !("command" in server)) {
  process.stderr.write("invalid mcp config\\n");
  process.exit(2);
}
const child = spawn(server.command, server.args ?? [], {
  env: { ...process.env, ...(server.env ?? {}) },
  stdio: ["pipe", "pipe", "pipe"],
});
let buffer = Buffer.alloc(0);
const pending = new Map();
let nextId = 1;
child.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) break;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = /(?:^|\\r\\n)Content-Length:\\s*(\\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) break;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.subarray(bodyStart + length);
    const message = JSON.parse(body);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  }
});
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error("mcp timeout " + method)), 8000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message ?? method));
      else resolve(message.result);
    });
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    child.stdin.write("Content-Length: " + Buffer.byteLength(payload) + "\\r\\n\\r\\n" + payload);
  });
}
try {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "fake-cli" },
  });
  await rpc("tools/list", {});
  const result = await rpc("tools/call", { name: tool, arguments: args });
  const text = JSON.stringify(result ?? {});
  process.stdout.write(
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "feito " } },
    }) + "\\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "result",
      result: "feito via ferramenta " + text.slice(0, 80),
    }) + "\\n",
  );
} catch (error) {
  process.stderr.write(String(error?.message ?? error) + "\\n");
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
}
`;
  await writeFile(executable, body, "utf8");
  await chmod(executable, 0o755);
  return { dir, executable };
}

async function fakeAcpCli(tool: string, args: Record<string, unknown>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "quibt-cli-acp-test-"));
  created.push(dir);
  const executable = path.join(dir, "my-agent");
  const body = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const tool = ${JSON.stringify(tool)};
const args = ${JSON.stringify(args)};
const lines = createInterface({ input: process.stdin });
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
async function callMcp(server) {
  const child = spawn(server.command, server.args ?? [], {
    env: {
      ...process.env,
      ...Object.fromEntries((server.env ?? []).map((item) => [item.name, item.value])),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = Buffer.alloc(0);
  const pending = new Map();
  let nextId = 1;
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
      if (headerEnd < 0) break;
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const match = /(?:^|\\r\\n)Content-Length:\\s*(\\d+)/i.exec(header);
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) break;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.subarray(bodyStart + length);
      const message = JSON.parse(body);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error("mcp timeout " + method)), 8000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message ?? method));
        else resolve(message.result);
      });
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      child.stdin.write("Content-Length: " + Buffer.byteLength(payload) + "\\r\\n\\r\\n" + payload);
    });
  }
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fake-acp" } });
  const result = await rpc("tools/call", { name: tool, arguments: args });
  child.kill("SIGTERM");
  return result;
}
for await (const line of lines) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    continue;
  }
  if (message.method === "session/new") {
    globalThis.__servers = (message.params?.mcpServers ?? [])[0];
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "sess-test" } });
    continue;
  }
  if (message.method === "session/prompt") {
    try {
      const stored = globalThis.__servers;
      const result = await callMcp(stored);
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess-test",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ACP ok " } },
        },
      });
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { stopReason: "end_turn", _meta: { toolResult: result } },
      });
    } catch (error) {
      send({ jsonrpc: "2.0", id: message.id, error: { message: String(error?.message ?? error) } });
    }
  }
}
`;
  await writeFile(executable, `${body}\n`, "utf8");
  await chmod(executable, 0o755);
  return { dir, executable };
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

  it("keeps OpenRouter, OAuth and Ollama on the Pi runtime", async () => {
    const primaryRun = vi.fn(async function* () {
      yield { type: "done" as const, text: "pi" };
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
    const runtime = new RoutedAgentRuntime(primary, new LocalCliAgentRuntime());
    for (const model of [
      { provider: "openrouter", id: "openai/gpt-4o" },
      { provider: "openai", id: "gpt-4o" },
      { provider: "ollama", id: "llama3.2" },
    ]) {
      await collect(runtime, request(model.id, model.provider));
    }
    expect(primaryRun).toHaveBeenCalledTimes(3);
    expect(runtime.describe().id).toBe("pi");
  });
});

describe("LocalCliAgentRuntime computer tools", () => {
  it("advertises tools and keeps Pi as the routed default engine", () => {
    const local = new LocalCliAgentRuntime();
    expect(local.describe().capabilities.tools).toBe(true);
    const routed = new RoutedAgentRuntime({
      describe: () => ({
        id: "pi",
        contractVersion: "1",
        adapterVersion: "test",
        capabilities: { streaming: true, compaction: true, tools: true, scripted: false },
      }),
      abort: async () => undefined,
      run: async function* () {
        yield { type: "done" as const, text: "pi" };
      },
    });
    expect(routed.describe().id).toBe("pi");
  });

  it("forwards a scripted shell tool through MCP to the fake sandbox", async () => {
    const sandbox = new FakeSandboxProvider();
    const computer = await sandbox.provision({ botId: "bot", homePath: "/home/bot" }, context);
    const { executable } = await fakeMcpCli("claude", "shell", { command: "echo hello-from-cli" });
    const executeTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
      const events = [];
      for await (const event of sandbox.execute(
        computer,
        { argv: ["echo", String(args.command ?? "")] },
        context,
      )) {
        events.push(event);
      }
      return { name, args, events };
    });

    const events = await collect(
      new LocalCliAgentRuntime({ resolveBinary: async () => executable }),
      request("claude", "local-cli", {
        tools: [shellTool, computerTool],
        executeTool,
      }),
    );

    expect(executeTool).toHaveBeenCalledWith(
      "shell",
      { command: "echo hello-from-cli" },
      expect.any(String),
    );
    const box = sandbox.session(computer);
    expect(box?.running).toBe(true);
    expect(events.some((event) => event.type === "tool" && event.name === "shell")).toBe(true);
    const last = events.at(-1);
    expect(last).toEqual(expect.objectContaining({ type: "done" }));
    expect(last && last.type === "done" ? last.text : "").toContain("feito");
  });

  it("surfaces an approval event for a destructive tool instead of executing it", async () => {
    const sandbox = new FakeSandboxProvider();
    const computer = await sandbox.provision({ botId: "bot", homePath: "/home/bot" }, context);
    const executed: string[] = [];
    const { executable } = await fakeMcpCli("claude", "shell", { command: "rm -rf /" });
    const executeTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
      const decision = decideToolPermission({}, name, args);
      if (decision.action === "ask") throw new PermissionRequiredError(decision.ask);
      executed.push(name);
      for await (const _event of sandbox.execute(
        computer,
        { argv: ["sh", "-c", String(args.command ?? "")] },
        context,
      )) {
        // The destructive path must never reach the sandbox.
      }
      return { ok: true };
    });

    const events = await collect(
      new LocalCliAgentRuntime({ resolveBinary: async () => executable }),
      request("claude", "local-cli", {
        tools: [shellTool],
        executeTool,
      }),
    );

    expect(executeTool).toHaveBeenCalledOnce();
    expect(executed).toEqual([]);
    expect(sandbox.session(computer)?.files.size).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "ask",
        text: "Preciso da sua aprovação",
        detail: expect.stringContaining("rm -rf"),
      }),
    );
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("forwards a computer tool from an extra ACP CLI and refuses an unknown path", async () => {
    const { executable } = await fakeAcpCli("computer", { action: "screenshot" });
    const executeTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
      return { name, args, ok: true };
    });
    const events = await collect(
      new LocalCliAgentRuntime({
        resolveBinary: async (id) => (id === EXTRA_ACP_CLI_ID ? executable : null),
      }),
      request(EXTRA_ACP_CLI_ID, "local-cli", {
        tools: [computerTool],
        executeTool,
      }),
    );
    expect(executeTool).toHaveBeenCalledWith(
      "computer",
      { action: "screenshot" },
      expect.any(String),
    );
    expect(events.some((event) => event.type === "text" && event.text.includes("ACP"))).toBe(true);

    const unknown = await collect(
      new LocalCliAgentRuntime({ extraAcpCli: "/bin/bash" }),
      request(EXTRA_ACP_CLI_ID),
    );
    expect(unknown).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringMatching(/não está disponível|desconhecida/i),
      }),
    );
  });
});
