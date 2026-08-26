import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  ConnectorTool,
} from "@quibt/adapter-kit";
import { MODEL_CONNECT_HINT } from "@quibt/core";
import { ApprovalPause } from "./approval-wait.js";
import { builtinAgentTools, DELEGATION_TOOL_NAMES } from "./builtin-tools.js";

const running = new Map<string, AbortController>();
const models = builtinModels();
const MAX_PARALLEL_SUBAGENTS = 4;

/**
 * Provedores de assinatura (Codex, Claude, Copilot, xAI) só resolvem auth a
 * partir de uma credencial armazenada — uma chave de API passada por cima é
 * ignorada e o provedor responde "Provider is not configured". Cada run recebe
 * a sua própria coleção de modelos com um cofre em memória, para que a
 * credencial de uma pessoa nunca vaze para o run de outra.
 */
function modelsForRun(oauthCredential: string | undefined, provider: string) {
  if (!oauthCredential) return models;
  let credential: unknown;
  try {
    credential = JSON.parse(oauthCredential);
  } catch {
    return models;
  }
  const vault = new Map<string, unknown>([[provider, credential]]);
  const store = {
    async read(providerId: string) {
      return vault.get(providerId) as never;
    },
    async list() {
      return [...vault.keys()].map((id) => ({
        providerId: id,
        type: "oauth" as const,
      }));
    },
    async modify(
      providerId: string,
      fn: (current: never) => Promise<never | undefined>,
    ): Promise<never | undefined> {
      const next = await fn(vault.get(providerId) as never);
      if (next !== undefined) vault.set(providerId, next);
      return vault.get(providerId) as never;
    },
    async delete(providerId: string) {
      vault.delete(providerId);
    },
  };
  return builtinModels({ credentials: store as never });
}

export class PiAgentRuntime implements AgentRuntime {
  describe() {
    return {
      id: "pi",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        streaming: true,
        compaction: true,
        tools: true,
        scripted: false,
      },
    };
  }

  async abort(runId: string): Promise<void> {
    running.get(runId)?.abort();
  }

  async *run(request: AgentRunRequest, context: AdapterContext): AsyncIterable<AgentRuntimeEvent> {
    const controller = new AbortController();
    running.set(request.runId, controller);
    // Honour both the executor's signal (cancel / approval pause) and our own abort().
    const signal = context.signal
      ? AbortSignal.any([context.signal, controller.signal])
      : controller.signal;
    const queue = createQueue();

    const work = (async () => {
      try {
        const provider =
          request.model.provider === "scripted" ? "openrouter" : request.model.provider;
        const modelId =
          request.model.id === "scripted"
            ? (process.env.PI_DEFAULT_MODEL ?? "deepseek/deepseek-v4-flash-0731")
            : request.model.id;
        if (provider === "ollama" || provider === "openai-compatible") {
          const apiKey = request.model.apiKey ?? "";
          for await (const event of streamOpenAiCompatible({
            provider,
            modelId,
            apiKey,
            prompt: request.prompt,
            instructions: request.instructions,
            signal,
          })) {
            queue.push(event);
          }
          return;
        }
        const runModels = modelsForRun(request.model.oauthCredential, provider);
        const model =
          runModels.getModel(provider, modelId) ?? runModels.getModel("openrouter", modelId);
        if (!model) {
          queue.push({
            type: "text",
            text: `Unknown model ${provider}/${modelId}`,
          });
          queue.push({ type: "done" });
          return;
        }

        const apiKey = request.model.apiKey ?? process.env.OPENROUTER_API_KEY;
        const toolDefs = request.tools.length ? request.tools : builtinAgentTools;
        const nestedAgents = new Set<Agent>();
        const host: ToolHost = {
          queue,
          request,
          model,
          apiKey,
          nestedAgents,
          subagentGate: createGate(MAX_PARALLEL_SUBAGENTS),
          signal,
          depth: 0,
          calls: { count: 0 },
        };
        const tools = toolDefs.map((tool) => toAgentTool(tool, host));
        const history = toHistory(request.history, request.prompt, model);

        const agent = new Agent({
          streamFn: (m, ctx, options) => runModels.streamSimple(m, ctx, options),
          // Com credencial de assinatura, o token já está no cofre do run: mandar
          // a chave por cima faria o provedor tentar o caminho de API key.
          getApiKey: async () => (request.model.oauthCredential ? undefined : apiKey),
          initialState: {
            systemPrompt:
              request.instructions ||
              "You are a Quibt Bot with a real computer. Use write_file, shell, memory, and request_takeover when they are the right tools. To show something, send it: `screenshot` puts a picture of your screen in the chat, `record_screen` puts a short video of it there, and `send_file` puts any file there — a PDF, a spreadsheet, a recording. Produce the file on your computer with `shell` first, then send its path. Be concise.",
            model,
            thinkingLevel: "off",
            tools,
            messages: history,
          },
        });

        if (signal.aborted) {
          queue.push({ type: "done", text: "stopped" });
          return;
        }
        const onAbort = () => {
          agent.abort();
          for (const nested of nestedAgents) nested.abort();
        };
        signal.addEventListener("abort", onAbort);

        let streamed = "";
        agent.subscribe((event) => {
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent.type === "text_delta"
          ) {
            const delta = event.assistantMessageEvent.delta;
            if (delta) {
              streamed += delta;
              queue.push({ type: "text", text: delta });
            }
          }
          if (event.type === "message_end" && event.message.role === "assistant") {
            const text = assistantText(event.message);
            if (text && !streamed) {
              streamed = text;
              queue.push({ type: "text", text });
            }
            if ("usage" in event.message && event.message.usage) {
              queue.push({
                type: "usage",
                inputTokens: event.message.usage.input ?? 0,
                outputTokens: event.message.usage.output ?? 0,
                provider: model.provider,
                model: model.id,
              });
            }
          }
        });

        queue.push({ type: "progress", text: "Trabalhando…" });
        await agent.prompt(request.prompt);
        await agent.waitForIdle();
        signal.removeEventListener("abort", onAbort);

        const error = agent.state.errorMessage;
        if (error) {
          queue.push({ type: "text", text: userFacingError(error) });
          queue.push({ type: "done", text: sanitizeError(error) });
          return;
        }
        if (!streamed) {
          const fallback = assistantText(agent.state.messages.at(-1)) || "Terminei o trabalho.";
          queue.push({ type: "text", text: fallback });
          streamed = fallback;
        }
        queue.push({ type: "done", text: streamed });
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        const message = sanitizeError(raw);
        queue.push({ type: "text", text: userFacingError(raw) });
        queue.push({ type: "done", text: message });
      } finally {
        queue.close();
      }
    })();

    try {
      yield* queue.iterate();
      await work;
    } finally {
      // The consumer stopped early (cancel, pause, takeover): make sure the model loop and
      // its tools stop too instead of running on unobserved.
      controller.abort();
      running.delete(request.runId);
    }
  }
}

/**
 * O histórico como o modelo o viu: o que o bot disse entra como fala do assistente, não
 * como um "Assistant: …" dentro de uma fala do usuário. Com o rótulo, o modelo aprendia o
 * padrão e começava a própria resposta com "Assistant:" — e a conversa virava um script.
 * Notas de sistema antigas seguem como texto do usuário, que é o que eram para o modelo.
 */
export function toHistory(
  history: AgentRunRequest["history"],
  prompt: string,
  model: { api: string; provider: string; id: string },
) {
  const last = history.at(-1);
  const prior = last?.content === prompt ? history.slice(0, -1) : history;
  const zeroUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return prior
    .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "system")
    .map((m) =>
      m.role === "assistant"
        ? {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: m.content }],
            api: model.api as never,
            provider: model.provider as never,
            model: model.id,
            usage: zeroUsage,
            stopReason: "stop" as const,
            timestamp: Date.now(),
          }
        : {
            role: "user" as const,
            content: m.role === "system" ? `System: ${m.content}` : m.content,
            timestamp: Date.now(),
          },
    );
}

/** Exported for tests. */
/**
 * Provedores OpenAI recusam nomes de ferramenta fora de `^[a-zA-Z0-9_-]+$`, e o
 * catálogo interno usa nomes com ponto (`destination.write`). O nome exposto ao
 * modelo é saneado; o nome original continua valendo dentro do executor.
 */
export function safeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function toAgentTool(tool: ConnectorTool, host: ToolHost): AgentTool {
  return {
    name: safeToolName(tool.name),
    label: tool.name,
    description: tool.description,
    parameters: parametersFor(tool),
    prepareArguments: (args: unknown) => {
      const raw = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      if (tool.name === "destination.write") {
        return {
          collection: String(raw.collection ?? "notes"),
          title: String(raw.title ?? "Quibt Bot result"),
          body: String(raw.body ?? ""),
        };
      }
      if (tool.name === "memory") {
        return {
          action: raw.action != null ? String(raw.action) : undefined,
          target: raw.target != null ? String(raw.target) : "memory",
          content: raw.content != null ? String(raw.content) : undefined,
          new_text: raw.new_text != null ? String(raw.new_text) : undefined,
          old_text: raw.old_text != null ? String(raw.old_text) : undefined,
          operations: Array.isArray(raw.operations) ? raw.operations : undefined,
        };
      }
      if (tool.name === "remember") {
        return {
          content: String(raw.content ?? ""),
          path: String(raw.path ?? "MEMORY.md"),
          target: raw.target != null ? String(raw.target) : undefined,
        };
      }
      if (tool.name === "request_takeover") {
        return { reason: String(raw.reason ?? "I need you on the screen.") };
      }
      if (tool.name === "write_file") {
        return {
          path: String(raw.path ?? "notes/result.txt"),
          content: String(raw.content ?? ""),
        };
      }
      if (tool.name === "shell") {
        return {
          command: String(raw.command ?? ""),
          cwd: raw.cwd ? String(raw.cwd) : "/home/quibt",
        };
      }
      if (tool.name === "run_subagent") {
        return {
          name: String(raw.name ?? "helper"),
          task: String(raw.task ?? ""),
          instructions: raw.instructions ? String(raw.instructions) : "",
        };
      }
      if (tool.name === "spawn_bot") {
        return {
          name: String(raw.name ?? ""),
          title: raw.title ? String(raw.title) : "",
          instructions: raw.instructions ? String(raw.instructions) : "",
          prompt: raw.prompt ? String(raw.prompt) : "",
        };
      }
      if (tool.name === "delete_bot") {
        return {
          confirm_name: String(raw.confirm_name ?? raw.confirmName ?? ""),
          bot_id: raw.bot_id ? String(raw.bot_id) : raw.botId ? String(raw.botId) : "",
        };
      }
      return raw as never;
    },
    execute: async (toolCallId, params) => {
      const args = (params ?? {}) as Record<string, unknown>;
      // Scoped by run: provider tool-call ids are not unique across runs or workspaces.
      // Without an id from the provider the tool name alone would repeat, and the effect
      // ledger would answer the second `shell` of a turn with the result of the first.
      const executionId = `${host.request.runId}:${toolCallId || nextCallSlot(host, tool.name)}`;
      host.queue.push({ type: "tool", name: tool.name, args, executionId });
      let authorizedResult: unknown;
      if (host.request.executeTool) {
        try {
          // Native runtime effects must cross the same executor approval boundary as connector
          // tools. In particular, never request takeover or create a subagent before this call.
          authorizedResult = await host.request.executeTool(tool.name, args, executionId);
        } catch (error) {
          // The executor paused the run (approval, teammate answer); end this turn instead of
          // handing the model an error it would try to work around.
          if (error instanceof ApprovalPause) {
            return {
              content: [{ type: "text", text: error.waitingText }],
              details: { paused: true },
              terminate: true,
            };
          }
          throw error;
        }
      } else {
        return {
          content: [
            {
              type: "text",
              text: `${tool.name} is unavailable without an executor.`,
            },
          ],
          details: { error: "no executor" },
        };
      }
      if (tool.name === "request_takeover") {
        host.queue.push({
          type: "takeover",
          reason: String(args.reason ?? "I need you on the screen."),
        });
        return {
          content: [{ type: "text", text: "Takeover requested." }],
          details: args,
          terminate: true,
        };
      }
      if (tool.name === "run_subagent") {
        const result = await executeSubagent(host, executionId, args);
        return {
          content: [{ type: "text", text: result }],
          details: { result },
        };
      }
      return {
        content: [{ type: "text", text: summarizeToolResult(authorizedResult) }],
        details: authorizedResult,
      };
    },
  };
}

/** Positional fallback id for providers that call tools without an id of their own. */
function nextCallSlot(host: ToolHost, toolName: string): string {
  host.calls ??= { count: 0 };
  host.calls.count += 1;
  return `${toolName}#${host.calls.count}`;
}

async function executeSubagent(host: ToolHost, executionId: string, args: Record<string, unknown>) {
  if (host.depth > 0) return "Subagents cannot nest further.";
  await host.subagentGate.acquire();
  const agentId = executionId;
  const name =
    String(args.name ?? "helper")
      .trim()
      .slice(0, 80) || "helper";
  const task = String(args.task ?? "").trim();
  const extra = args.instructions ? String(args.instructions).trim() : "";
  host.queue.push({
    type: "subagent",
    agentId,
    name,
    task,
    status: "running",
    progress: "starting…",
  });

  const childDefs = (host.request.tools.length ? host.request.tools : builtinAgentTools).filter(
    (tool) => !DELEGATION_TOOL_NAMES.has(tool.name),
  );
  const nestedHost: ToolHost = { ...host, depth: 1 };
  const nested = new Agent({
    streamFn: (m, ctx, options) => models.streamSimple(m, ctx, options),
    getApiKey: async () => host.apiKey,
    initialState: {
      systemPrompt: [
        `You are a Quibt subagent named "${name}".`,
        "You run inside the parent bot's turn — you are not a separate bot chat.",
        "Complete the task and return a concise result. Do not spawn bots or further subagents.",
        extra,
      ]
        .filter(Boolean)
        .join(" "),
      model: host.model,
      thinkingLevel: "off",
      tools: childDefs.map((tool) => toAgentTool(tool, nestedHost)),
      messages: [],
    },
  });
  host.nestedAgents.add(nested);

  let streamed = "";
  let lastPush = 0;
  nested.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      const toolName = "toolName" in event && event.toolName ? String(event.toolName) : "a tool";
      host.queue.push({
        type: "subagent",
        agentId,
        name,
        task,
        status: "running",
        progress: `using ${toolName}…`,
      });
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const delta = event.assistantMessageEvent.delta;
      if (delta) {
        streamed += delta;
        const now = Date.now();
        if (now - lastPush >= 80) {
          lastPush = now;
          host.queue.push({
            type: "subagent",
            agentId,
            name,
            task,
            status: "running",
            progress: streamed.slice(-800),
          });
        }
      }
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const text = assistantText(event.message);
      if (text && !streamed) streamed = text;
      if ("usage" in event.message && event.message.usage) {
        host.queue.push({
          type: "usage",
          inputTokens: event.message.usage.input ?? 0,
          outputTokens: event.message.usage.output ?? 0,
          provider: host.model.provider,
          model: host.model.id,
        });
      }
    }
  });

  try {
    if (host.signal.aborted) {
      host.queue.push({
        type: "subagent",
        agentId,
        name,
        task,
        status: "failed",
        result: "stopped",
      });
      return "stopped";
    }
    const onAbort = () => nested.abort();
    host.signal.addEventListener("abort", onAbort);
    await nested.prompt(task || "Complete the delegated task.");
    await nested.waitForIdle();
    host.signal.removeEventListener("abort", onAbort);
    const error = nested.state.errorMessage;
    if (error) {
      const message = sanitizeError(error);
      host.queue.push({
        type: "subagent",
        agentId,
        name,
        task,
        status: "failed",
        result: message,
      });
      return `Subagent failed: ${message}`;
    }
    const result = streamed || assistantText(nested.state.messages.at(-1)) || "done.";
    const clipped = result.length > 12_000 ? `${result.slice(0, 12_000)}…` : result;
    host.queue.push({
      type: "subagent",
      agentId,
      name,
      task,
      status: "completed",
      result: clipped,
    });
    return clipped;
  } catch (error) {
    const message = sanitizeError(error instanceof Error ? error.message : String(error));
    host.queue.push({
      type: "subagent",
      agentId,
      name,
      task,
      status: "failed",
      result: message,
    });
    return `Subagent failed: ${message}`;
  } finally {
    host.nestedAgents.delete(nested);
    host.subagentGate.release();
  }
}

function parametersFor(tool: ConnectorTool) {
  if (tool.name === "write_file") {
    return Type.Object({ path: Type.String(), content: Type.String() });
  }
  if (tool.name === "destination.write") {
    return Type.Object({
      collection: Type.String(),
      title: Type.String(),
      body: Type.String(),
    });
  }
  if (tool.name === "request_takeover") {
    return Type.Object({ reason: Type.String() });
  }
  if (tool.name === "memory") {
    return Type.Object({
      action: Type.Optional(Type.String()),
      target: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()),
      new_text: Type.Optional(Type.String()),
      old_text: Type.Optional(Type.String()),
      operations: Type.Optional(Type.Array(Type.Unknown())),
    });
  }
  if (tool.name === "remember") {
    return Type.Object({
      content: Type.String(),
      path: Type.Optional(Type.String()),
      target: Type.Optional(Type.String()),
    });
  }
  if (tool.name === "shell") {
    return Type.Object({
      command: Type.String(),
      cwd: Type.String(),
    });
  }
  if (tool.name === "run_subagent") {
    return Type.Object({
      name: Type.String(),
      task: Type.String(),
      instructions: Type.Optional(Type.String()),
    });
  }
  if (tool.name === "spawn_bot") {
    return Type.Object({
      name: Type.String(),
      title: Type.Optional(Type.String()),
      instructions: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String()),
    });
  }
  if (tool.name === "delete_bot") {
    return Type.Object({
      confirm_name: Type.String(),
      bot_id: Type.Optional(Type.String()),
    });
  }
  return jsonSchemaParameters(tool.inputSchema);
}

function jsonSchemaParameters(schema: Record<string, unknown>) {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const fields: Record<string, ReturnType<typeof Type.Optional>> = {};
  for (const [key, spec] of Object.entries(properties)) {
    const field = jsonField(spec);
    fields[key] = (required.has(key) ? field : Type.Optional(field)) as unknown as ReturnType<
      typeof Type.Optional
    >;
  }
  return Type.Object(fields);
}

function jsonField(spec: unknown): ReturnType<typeof Type.String> {
  const type =
    spec && typeof spec === "object" && "type" in spec
      ? String((spec as { type?: unknown }).type)
      : "string";
  if (type === "number" || type === "integer") return Type.Number() as never;
  if (type === "boolean") return Type.Boolean() as never;
  if (type === "array") return Type.Array(Type.Unknown()) as never;
  if (type === "object") return Type.Record(Type.String(), Type.Unknown()) as never;
  return Type.String();
}

function summarizeToolResult(result: unknown) {
  try {
    const text = JSON.stringify(result);
    if (!text) return "ok";
    return text.length > 12_000 ? `${text.slice(0, 12_000)}…` : text;
  } catch {
    return "ok";
  }
}

function assistantText(message: unknown): string {
  if (!message || typeof message !== "object" || !("content" in message)) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part
        ? String(part.text)
        : "",
    )
    .join("");
}

/**
 * O que o usuário lê no chat quando o run falha: português, e dizendo o que fazer. As
 * três mensagens de modelo terminam no mesmo `MODEL_CONNECT_HINT` de `@quibt/core`:
 * mandavam para "Conta → Modelos e tokens", que é só um título dentro da aba — o menu
 * tem "Modelo", e o composer tem o botão "Conectar modelo".
 */
export function userFacingError(message: string) {
  const clean = sanitizeError(message);
  const missingProvider = /Provider is not configured:\s*(\S+)/i.exec(clean);
  if (missingProvider) {
    return `Ainda não tenho um modelo conectado (${missingProvider[1]}). Depois é só me chamar de novo. ${MODEL_CONNECT_HINT}`;
  }
  if (
    /personal-team-blocked:spending-limit/i.test(clean) ||
    /You have run out of credits or need a Grok subscription/i.test(clean)
  ) {
    return `A xAI recusou este pedido porque a conta conectada está sem créditos ou sem uma assinatura Grok válida. Conecte outra assinatura ou chave, ou libere a cota no Grok, e me chame de novo. ${MODEL_CONNECT_HINT}`;
  }
  // Parte do catálogo do Codex só atende quem paga por chave de API. Dizer isso em
  // inglês e sem saída deixava a pessoa parada.
  const refusedModel =
    /The '([^']+)' model is not supported when using .* with a (\w+) account/i.exec(clean);
  if (refusedModel) {
    return `A sua assinatura ${refusedModel[2]} não libera o modelo ${refusedModel[1]}. Escolha outro — o GPT-5.6 Terra funciona com assinatura. ${MODEL_CONNECT_HINT}`;
  }
  return `Não consegui concluir: ${clean}`;
}

function sanitizeError(message: string) {
  return message
    .replace(/sk-or-v1-[a-zA-Z0-9]+/g, "[redacted]")
    .replace(/sk-[a-zA-Z0-9-]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[redacted]")
    .replace(/COMPOSIO_API_KEY[=:]?\s*\S+/gi, "COMPOSIO_API_KEY=[redacted]");
}

interface EventQueue {
  push(event: AgentRuntimeEvent): void;
  close(): void;
  iterate(): AsyncIterable<AgentRuntimeEvent>;
}

export interface ToolHost {
  queue: EventQueue;
  /** Shared with nested hosts by reference, so a subagent never reuses a parent slot. */
  calls?: { count: number };
  request: AgentRunRequest;
  model: NonNullable<ReturnType<typeof models.getModel>>;
  apiKey: string | undefined;
  nestedAgents: Set<Agent>;
  subagentGate: { acquire(): Promise<void>; release(): void };
  signal: AbortSignal;
  depth: number;
}

function createGate(max: number) {
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    async acquire() {
      if (active >= max) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
      active += 1;
    },
    release() {
      active = Math.max(0, active - 1);
      waiters.shift()?.();
    },
  };
}

/** Merge consecutive token deltas so a slow consumer does not grow an unbounded queue. */
export function enqueueRuntimeEvent(items: AgentRuntimeEvent[], event: AgentRuntimeEvent): void {
  const last = items[items.length - 1];
  if (event.type === "text" && last?.type === "text") {
    last.text += event.text;
    return;
  }
  items.push(event);
}

function createQueue(): EventQueue {
  const items: AgentRuntimeEvent[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    push(event) {
      enqueueRuntimeEvent(items, event);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *iterate() {
      while (!closed || items.length) {
        if (items.length) {
          yield items.shift()!;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

/**
 * A URL em que o runtime fala com o servidor local. A sonda de `models.connect` confirma
 * a raiz do Ollama (`/api/tags`) e é a raiz que o cofre guarda; `chat/completions` o
 * Ollama só serve sob `/v1`, então o sufixo entra aqui — nunca duplicado. LM Studio e
 * afins já vêm com `/v1` na URL.
 */
export function localBaseUrl(provider: string, apiKey: string): string {
  const trimmed = apiKey.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    return provider === "ollama" ? "http://127.0.0.1:11434/v1" : "http://127.0.0.1:1234/v1";
  }
  if (provider === "ollama" && !/\/v1$/i.test(trimmed)) return `${trimmed}/v1`;
  return trimmed;
}

async function* streamOpenAiCompatible(input: {
  provider: string;
  modelId: string;
  apiKey: string;
  prompt: string;
  instructions?: string;
  signal: AbortSignal;
}): AsyncIterable<AgentRuntimeEvent> {
  const base = localBaseUrl(input.provider, input.apiKey);
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: input.modelId,
      stream: false,
      messages: [
        ...(input.instructions ? [{ role: "system", content: input.instructions }] : []),
        { role: "user", content: input.prompt },
      ],
    }),
    signal: input.signal,
  });
  if (!res.ok) {
    yield {
      type: "text",
      text: `O modelo local em ${base} respondeu ${res.status}.`,
    };
    yield { type: "done" };
    return;
  }
  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = body.choices?.[0]?.message?.content ?? "";
  if (text) yield { type: "text", text };
  yield { type: "done" };
}
