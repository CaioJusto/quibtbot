import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentRuntimeEvent } from "@quibt/adapter-kit";

const ACP_PROTOCOL_VERSION = 1;

type RpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string; code?: number };
};

export type AcpMcpServer = {
  name: string;
  command: string;
  args: string[];
};

export async function runAcpAgent(options: {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  mcp: AcpMcpServer;
  signal: AbortSignal;
  onEvent: (event: AgentRuntimeEvent) => void;
}): Promise<{ text: string }> {
  const child = spawn(options.executable, [], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 1;
  let streamed = "";
  const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  const abort = () => terminate(child);
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();

  const onLine = (line: string) => {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }
    if (message.method === "session/update") {
      const text = acpUpdateText(message.params);
      if (text) {
        streamed += text;
        options.onEvent({ type: "text", text });
      }
      return;
    }
    if (message.method === "session/request_permission" && message.id !== undefined) {
      writeLine(child, {
        jsonrpc: "2.0",
        id: message.id,
        result: acpAllowOnce(message.params),
      });
      return;
    }
    if (
      message.method &&
      (message.method.startsWith("fs/") || message.method.startsWith("terminal/")) &&
      message.id !== undefined
    ) {
      writeLine(child, {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Host filesystem and terminal are not exposed." },
      });
      return;
    }
    if (message.id !== undefined && pending.has(Number(message.id))) {
      const waiter = pending.get(Number(message.id));
      pending.delete(Number(message.id));
      if (message.error) waiter?.reject(new Error(message.error.message ?? "ACP error"));
      else waiter?.resolve(message.result);
    }
  };
  lines.on("line", onLine);

  const rpc = async (method: string, params: Record<string, unknown>) => {
    const id = nextId;
    nextId += 1;
    const result = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    writeLine(child, { jsonrpc: "2.0", id, method, params });
    return result;
  };

  const close = new Promise<{ code: number | null; error?: unknown }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, error }));
    child.once("close", (code) => resolve({ code }));
  });

  try {
    await rpc("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "quibt", title: "Quibt" },
    });
    const created = (await rpc("session/new", {
      cwd: options.cwd,
      mcpServers: [
        {
          name: options.mcp.name,
          command: options.mcp.command,
          args: options.mcp.args,
          env: [],
        },
      ],
    })) as { sessionId?: string } | null;
    const sessionId = created?.sessionId;
    if (!sessionId) throw new Error("CLI ACP não devolveu sessionId.");
    await rpc("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: options.prompt }],
    });
    child.stdin.end();
    terminate(child);
    const finished = await close;
    if (finished.error && !streamed) {
      throw finished.error instanceof Error ? finished.error : new Error(String(finished.error));
    }
    return { text: streamed };
  } finally {
    options.signal.removeEventListener("abort", abort);
    lines.close();
    if (child.exitCode === null && child.signalCode === null) terminate(child);
  }
}

function acpUpdateText(params: Record<string, unknown> | undefined): string | undefined {
  const update = object(params?.update);
  const content = object(update?.content);
  if (update?.sessionUpdate === "agent_message_chunk" && typeof content?.text === "string") {
    return content.text;
  }
  return undefined;
}

function acpAllowOnce(params: Record<string, unknown> | undefined) {
  const options = Array.isArray(params?.options) ? params.options : [];
  const typed = options.filter((item): item is { optionId: string; kind?: string } =>
    Boolean(
      item &&
        typeof item === "object" &&
        typeof (item as { optionId?: unknown }).optionId === "string",
    ),
  );
  const selected =
    typed.find((item) => item.kind === "allow_once") ??
    typed.find((item) => item.kind?.startsWith("allow")) ??
    typed[0];
  if (!selected) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: selected.optionId } };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function writeLine(child: ChildProcessWithoutNullStreams, message: unknown): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function terminate(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 2_000);
  timer.unref();
}
