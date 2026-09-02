import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@quibt/adapter-kit";
import { runAcpAgent } from "./cli-acp.js";
import {
  CLI_MCP_SERVER_NAME,
  type CliToolBridge,
  createRuntimeEventQueue,
  startCliToolBridge,
  writeCliMcpConfig,
  writeCliMcpProxy,
} from "./cli-tool-bridge.js";
import {
  EXTRA_ACP_CLI_ID,
  isLocalCliId,
  LOCAL_CLI_PROVIDER,
  type LocalCliDetectionOptions,
  type LocalCliId,
  localCliLabel,
  resolveLocalCli,
} from "./local-cli.js";

const running = new Map<string, ChildProcessWithoutNullStreams>();
const MAX_STDERR_CHARS = 8_000;

type ParsedLine = {
  text?: string;
  finalText?: string;
  inputTokens?: number;
  outputTokens?: number;
};

export type LocalCliAgentRuntimeOptions = LocalCliDetectionOptions & {
  resolveBinary?: (id: LocalCliId) => Promise<string | null>;
};

/** Runs an already-authenticated host CLI as a response-only model engine. */
export class LocalCliAgentRuntime implements AgentRuntime {
  constructor(private readonly options: LocalCliAgentRuntimeOptions = {}) {}

  describe() {
    return {
      id: LOCAL_CLI_PROVIDER,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
    };
  }

  async abort(runId: string): Promise<void> {
    const child = running.get(runId);
    if (child) terminate(child);
  }

  async *run(request: AgentRunRequest, context: AdapterContext): AsyncIterable<AgentRuntimeEvent> {
    if (request.model.provider !== LOCAL_CLI_PROVIDER || !isLocalCliId(request.model.id)) {
      yield {
        type: "error",
        message:
          "CLI local desconhecida. Use Claude Code, Codex, Grok ou a CLI ACP extra detectada pelo Quibt.",
        retryable: false,
      };
      yield { type: "done", text: "CLI local desconhecida." };
      return;
    }

    const id = request.model.id;
    const executable = await (this.options.resolveBinary
      ? this.options.resolveBinary(id)
      : resolveLocalCli(id, this.options));
    if (!executable) {
      const message = `${localCliLabel(id)} não está disponível no PATH do host da API/worker.`;
      yield { type: "error", message, retryable: false };
      yield { type: "done", text: message };
      return;
    }

    const isolatedCwd = await mkdtemp(path.join(os.tmpdir(), "quibt-cli-engine-"));
    const prompt = cliPrompt(request);
    const queue = createRuntimeEventQueue();
    const useTools = Boolean(request.executeTool) && request.tools.length > 0;
    let bridge: CliToolBridge | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    let slot = 0;
    let settled = false;

    const finish = (...events: AgentRuntimeEvent[]) => {
      if (settled) return;
      settled = true;
      for (const event of events) queue.push(event);
    };

    const work = (async () => {
      try {
        queue.push({ type: "progress", text: `Consultando ${localCliLabel(id)} no host…` });
        let mcp: { configPath: string; proxyPath: string } | undefined;
        if (useTools) {
          bridge = await startCliToolBridge({
            tools: request.tools,
            executeTool: request.executeTool,
            nextExecutionId: (name) => {
              slot += 1;
              return `${request.runId}:${name}#${slot}`;
            },
            onTool: (event) => queue.push({ type: "tool", ...event }),
            onPermission: (ask) => {
              finish(
                { type: "ask", text: "Preciso da sua aprovação", detail: ask.summary },
                { type: "done", text: "Preciso da sua aprovação" },
              );
              if (child) terminate(child);
            },
            onPause: () => {
              if (child) terminate(child);
            },
          });
          const proxyPath = await writeCliMcpProxy(isolatedCwd, bridge.port);
          const configPath = await writeCliMcpConfig(isolatedCwd, process.execPath, [proxyPath]);
          mcp = { configPath, proxyPath };
        }

        if (id === EXTRA_ACP_CLI_ID) {
          if (!mcp) {
            finish(
              {
                type: "error",
                message: "CLI ACP precisa das ferramentas do computador do bot.",
                retryable: false,
              },
              { type: "done", text: "CLI ACP precisa das ferramentas do computador do bot." },
            );
            return;
          }
          const result = await runAcpAgent({
            executable,
            cwd: isolatedCwd,
            env: cliEnvironment(this.options.env ?? process.env),
            prompt,
            mcp: {
              name: CLI_MCP_SERVER_NAME,
              command: process.execPath,
              args: [mcp.proxyPath],
            },
            signal: context.signal,
            onEvent: (event) => queue.push(event),
          });
          if (!result.text) {
            const message = `${localCliLabel(id)} terminou sem devolver texto.`;
            finish({ type: "error", message, retryable: true }, { type: "done", text: message });
            return;
          }
          finish({ type: "done", text: result.text });
          return;
        }

        const invocation = cliInvocation(id, isolatedCwd, prompt, mcp);
        try {
          child = spawn(executable, invocation.argv, {
            cwd: isolatedCwd,
            env: cliEnvironment(this.options.env ?? process.env),
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          });
        } catch (error) {
          const message = cliError(id, error);
          finish({ type: "error", message, retryable: true }, { type: "done", text: message });
          return;
        }

        running.set(request.runId, child);
        const abort = () => {
          if (child) terminate(child);
        };
        context.signal.addEventListener("abort", abort, { once: true });
        if (context.signal.aborted) abort();
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          if (stderr.length < MAX_STDERR_CHARS)
            stderr += chunk.slice(0, MAX_STDERR_CHARS - stderr.length);
        });
        child.stdin.on("error", () => undefined);
        if (invocation.stdin !== undefined) child.stdin.end(invocation.stdin);
        else child.stdin.end();

        const close = new Promise<{ code: number | null; error?: unknown }>((resolve) => {
          child!.once("error", (error) => resolve({ code: null, error }));
          child!.once("close", (code) => resolve({ code }));
        });
        const lines = createInterface({
          input: child.stdout,
          crlfDelay: Number.POSITIVE_INFINITY,
        });
        let streamed = "";
        let fallback = "";
        let inputTokens = 0;
        let outputTokens = 0;
        try {
          for await (const line of lines) {
            if (settled) break;
            const parsed = parseCliLine(id, line);
            if (!parsed) continue;
            if (parsed.text) {
              streamed += parsed.text;
              queue.push({ type: "text", text: parsed.text });
            }
            if (parsed.finalText) fallback = parsed.finalText;
            inputTokens = parsed.inputTokens ?? inputTokens;
            outputTokens = parsed.outputTokens ?? outputTokens;
          }
          const result = await close;
          if (settled) return;
          if (result.error || (result.code !== 0 && !context.signal.aborted)) {
            const detail =
              result.error ?? (stderr || `processo terminou com código ${result.code}`);
            const message = cliError(id, detail);
            finish({ type: "error", message, retryable: true }, { type: "done", text: message });
            return;
          }
          if (context.signal.aborted) {
            finish({ type: "done", text: "stopped" });
            return;
          }
          if (!streamed && fallback) {
            streamed = fallback;
            queue.push({ type: "text", text: fallback });
          }
          if (!streamed) {
            const message = `${localCliLabel(id)} terminou sem devolver texto.`;
            finish({ type: "error", message, retryable: true }, { type: "done", text: message });
            return;
          }
          if (inputTokens || outputTokens) {
            queue.push({
              type: "usage",
              inputTokens,
              outputTokens,
              provider: LOCAL_CLI_PROVIDER,
              model: id,
            });
          }
          finish({ type: "done", text: streamed });
        } finally {
          context.signal.removeEventListener("abort", abort);
          running.delete(request.runId);
          lines.close();
        }
      } catch (error) {
        const message = cliError(id, error);
        finish({ type: "error", message, retryable: true }, { type: "done", text: message });
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) terminate(child);
        await bridge?.close();
        await rm(isolatedCwd, { recursive: true, force: true });
        queue.close();
      }
    })();

    yield* queue.iterate();
    await work;
  }
}

/** Keeps every Pi provider and delegates only the explicit local-cli provider. */
export class RoutedAgentRuntime implements AgentRuntime {
  constructor(
    private readonly primary: AgentRuntime,
    private readonly localCli: AgentRuntime = new LocalCliAgentRuntime(),
  ) {}

  describe() {
    return this.primary.describe();
  }

  async abort(runId: string): Promise<void> {
    await Promise.all([this.primary.abort(runId), this.localCli.abort(runId)]);
  }

  run(request: AgentRunRequest, context: AdapterContext): AsyncIterable<AgentRuntimeEvent> {
    return request.model.provider === LOCAL_CLI_PROVIDER
      ? this.localCli.run(request, context)
      : this.primary.run(request, context);
  }
}

function cliInvocation(
  id: LocalCliId,
  cwd: string,
  prompt: string,
  mcp?: { configPath: string; proxyPath: string },
) {
  const mcpArgv = mcp && id !== "codex" ? ["--mcp-config", mcp.configPath] : [];
  const claudeMcpArgv = mcp ? ["--strict-mcp-config", "--mcp-config", mcp.configPath] : [];
  const codexMcpArgv = mcp
    ? [
        "-c",
        `mcp_servers.${CLI_MCP_SERVER_NAME}.command=${JSON.stringify(process.execPath)}`,
        "-c",
        `mcp_servers.${CLI_MCP_SERVER_NAME}.args=${JSON.stringify([mcp.proxyPath])}`,
        "-c",
        `mcp_servers.${CLI_MCP_SERVER_NAME}.default_tools_approval_mode="approve"`,
      ]
    : [];
  if (id === "claude") {
    return {
      argv: [
        "-p",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--no-session-persistence",
        "--permission-mode",
        "dontAsk",
        "--tools",
        "",
        ...claudeMcpArgv,
      ],
      stdin: prompt,
    };
  }
  if (id === "codex") {
    return {
      argv: [
        "exec",
        "--json",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "-C",
        cwd,
        ...codexMcpArgv,
        "-",
      ],
      stdin: prompt,
    };
  }
  return {
    argv: [
      "--no-auto-update",
      "--cwd",
      cwd,
      "--output-format",
      "streaming-json",
      ...(mcp ? [] : ["--tools", "", "--max-turns", "1"]),
      "--no-subagents",
      "--no-memory",
      "--disable-web-search",
      ...mcpArgv,
      "-p",
      prompt,
    ],
    stdin: undefined,
  };
}

function cliPrompt(request: AgentRunRequest): string {
  const history = request.history
    .map((message) => `<${message.role}>\n${message.content}\n</${message.role}>`)
    .join("\n\n");
  return [
    request.instructions,
    "You are the model for a Quibt bot. Reply in this chat. Use the Quibt computer tools (shell, write_file, screenshot, computer, open_url, and the others provided) to act on this bot's Linux computer — Docker, VPS, E2B, Box, or Daytona. Those tools run in the bot computer, not on the host Mac/Windows. Do not use the CLI's built-in host shell, file, or browser tools. Do not inspect or modify files on the API/worker host.",
    history ? `Conversation so far:\n${history}` : "",
    `<user>\n${request.prompt}\n</user>`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * A model process needs PATH and its per-user login files, not the API's database,
 * encryption, sandbox, or provider keys. In particular, API keys are omitted so each CLI
 * uses the subscription session created by its own login command.
 */
export function cliEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const exact = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "TERM",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "ComSpec",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PATHEXT",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "GROK_HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    "REQUESTS_CA_BUNDLE",
  ]);
  const prefixes = ["LC_", "XDG_"];
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) =>
        value !== undefined &&
        (exact.has(key) || prefixes.some((prefix) => key.startsWith(prefix))),
    ),
  );
}

export function parseCliLine(id: LocalCliId, line: string): ParsedLine | null {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (id === "claude") return parseClaudeLine(event);
  if (id === "codex") return parseCodexLine(event);
  return parseGrokLine(event);
}

function parseClaudeLine(event: Record<string, unknown>): ParsedLine | null {
  const stream = object(event.event);
  const delta = object(stream?.delta);
  if (stream?.type === "content_block_delta" && typeof delta?.text === "string") {
    return { text: delta.text };
  }
  const usage = object(event.usage);
  if (event.type === "result") {
    return {
      finalText: stringValue(event.result),
      inputTokens: numberValue(usage?.input_tokens),
      outputTokens: numberValue(usage?.output_tokens),
    };
  }
  return null;
}

function parseCodexLine(event: Record<string, unknown>): ParsedLine | null {
  const item = object(event.item);
  if (event.type === "item.completed" && item?.type === "agent_message") {
    return { text: stringValue(item.text) };
  }
  if (event.type === "item.updated" && item?.type === "agent_message") {
    const delta = object(event.delta);
    return { text: stringValue(delta?.text) };
  }
  if (event.type === "turn.completed") {
    const usage = object(event.usage);
    return {
      inputTokens: numberValue(usage?.input_tokens),
      outputTokens: numberValue(usage?.output_tokens),
    };
  }
  return null;
}

function parseGrokLine(event: Record<string, unknown>): ParsedLine | null {
  const delta = object(event.delta);
  const content = object(event.content);
  const update = object(object(event.params)?.update);
  const updateContent = object(update?.content);
  if (event.type === "text" && typeof event.data === "string") {
    return { text: event.data };
  }
  if (update?.sessionUpdate === "agent_message_chunk" && typeof updateContent?.text === "string") {
    return { text: updateContent.text };
  }
  if (typeof delta?.text === "string") return { text: delta.text };
  if (typeof content?.text === "string" && /chunk|delta/i.test(String(event.type ?? ""))) {
    return { text: content.text };
  }
  if (typeof event.text === "string" && /chunk|delta/i.test(String(event.type ?? ""))) {
    return { text: event.text };
  }
  const result = object(event.result);
  const usage = object(event.usage) ?? object(result?.usage);
  return {
    finalText:
      stringValue(result?.text) ?? stringValue(result?.content) ?? stringValue(event.response),
    inputTokens: numberValue(usage?.input_tokens) ?? numberValue(usage?.inputTokens),
    outputTokens: numberValue(usage?.output_tokens) ?? numberValue(usage?.outputTokens),
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cliError(id: LocalCliId, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const detail = raw.trim().split("\n").at(-1)?.slice(0, 500) || "falha desconhecida";
  return `${localCliLabel(id)} falhou no host: ${detail}`;
}

function terminate(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 2_000);
  timer.unref();
}
