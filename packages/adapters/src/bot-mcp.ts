import { spawn } from "node:child_process";
import type { ConnectorTool } from "@quibt/adapter-kit";
import { BOT_MCP_LIMITS, CAPABILITY_LIMITS } from "@quibt/contracts";
import { redactSecrets } from "@quibt/core";
import { builtinAgentTools } from "./builtin-tools.js";
import { callMcpTool, discoverMcpTools, mcpToolName, parseMcpToolName } from "./mcp-http.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SAFE_HOST_ENV = ["PATH", "HOME", "USER", "LANG", "TERM", "TMPDIR"] as const;
const REQUEST_TIMEOUT_MS = 4_000;
const DISPOSE_GRACE_MS = 250;
const MAX_STDIO_RESPONSE_BYTES = 1024 * 1024;

export type RuntimeBotMcpServer = {
  id: string;
  workspaceId: string;
  botId: string;
  name: string;
  transport: string;
  command: string | null;
  args: string[];
  url: string | null;
  env: unknown;
  enabled: boolean;
};

export type BotMcpRuntime = {
  tools: ConnectorTool[];
  has(toolName: string): boolean;
  call(toolName: string, args: Record<string, unknown>): Promise<unknown>;
  dispose(): Promise<void>;
};

export type BotMcpRuntimeOptions = {
  disable?: (server: RuntimeBotMcpServer, reason: string) => Promise<unknown>;
  maxTools?: number;
};

type RpcResponse = { id?: number; result?: unknown; error?: { message?: string } };
type McpToolDescription = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

function serverEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export function botMcpSecretValues(servers: RuntimeBotMcpServer[]): string[] {
  return servers.flatMap((server) => Object.values(serverEnv(server.env))).filter(Boolean);
}

function safeChildEnv(explicit: Record<string, string>): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    SAFE_HOST_ENV.flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );
  return { ...inherited, ...explicit };
}

function sanitizeValue(value: unknown, secrets: string[]): unknown {
  if (!secrets.length) return value;
  try {
    const redacted = redactSecrets(JSON.stringify(value), secrets);
    return JSON.parse(redacted) as unknown;
  } catch {
    return redactSecrets(String(value), secrets);
  }
}

function failureReason(error: unknown, secrets: string[]): string {
  return redactSecrets(error instanceof Error ? error.message : String(error), secrets)
    .replace(/[\r\n]+/g, " ")
    .slice(0, 240);
}

export function botMcpToolName(serverName: string, toolName: string): string {
  return mcpToolName(serverName, toolName);
}

class StdioMcpClient {
  private readonly child;
  private readonly ready: Promise<void>;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private disposing = false;

  constructor(command: string, args: string[], env: Record<string, string>) {
    this.child = spawn(command, args, {
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
      env: safeChildEnv(env),
    });
    this.ready = new Promise((resolve, reject) => {
      this.child.once("spawn", resolve);
      this.child.once("error", reject);
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.parseFrames();
    });
    this.child.stdin.on("error", () => undefined);
    this.child.once("exit", (code, signal) => {
      if (this.disposing) return;
      this.rejectPending(new Error(`MCP process exited (${code ?? signal ?? "unknown"})`));
    });
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private parseFrames() {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const lengthMatch = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(lengthMatch[1]);
      if (length > MAX_STDIO_RESPONSE_BYTES) {
        this.buffer = Buffer.alloc(0);
        this.rejectPending(new Error("MCP response is too large"));
        this.child.kill("SIGTERM");
        return;
      }
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      try {
        const response = JSON.parse(body) as RpcResponse;
        if (typeof response.id !== "number") continue;
        const pending = this.pending.get(response.id);
        if (!pending) continue;
        this.pending.delete(response.id);
        clearTimeout(pending.timer);
        if (response.error)
          pending.reject(new Error(response.error.message ?? "MCP request failed"));
        else pending.resolve(response.result);
      } catch {
        // Ignore malformed frames. The bounded request timer will fail the handshake safely.
      }
    }
  }

  private write(message: Record<string, unknown>) {
    const body = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.ready;
    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
    this.write({ jsonrpc: "2.0", id, method, params });
    return response;
  }

  async notify(method: string, params: Record<string, unknown> = {}) {
    await this.ready;
    this.write({ jsonrpc: "2.0", method, params });
  }

  async initialize(): Promise<McpToolDescription[]> {
    await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "quibtbot", version: "1.0.0" },
    });
    await this.notify("notifications/initialized");
    const listed = (await this.request("tools/list", {})) as { tools?: McpToolDescription[] };
    return Array.isArray(listed?.tools) ? listed.tools : [];
  }

  call(tool: string, args: Record<string, unknown>) {
    return this.request("tools/call", { name: tool, arguments: args });
  }

  async dispose() {
    if (this.disposing) return;
    this.disposing = true;
    this.rejectPending(new Error("MCP process disposed"));
    this.child.stdin.end();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.child.kill("SIGTERM");
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), DISPOSE_GRACE_MS);
        timer.unref?.();
      }),
    ]);
    if (!graceful && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
      await exited;
    }
  }
}

/** Connects each enabled row independently; one dead server never takes down discovery. */
export async function connectBotMcpServers(
  input: RuntimeBotMcpServer[],
  options: BotMcpRuntimeOptions = {},
): Promise<BotMcpRuntime> {
  const servers = input.filter((server) => server.enabled).slice(0, BOT_MCP_LIMITS.serversPerBot);
  const maxTools = Math.max(
    0,
    Math.min(options.maxTools ?? CAPABILITY_LIMITS.mcpToolsTotal, CAPABILITY_LIMITS.mcpToolsTotal),
  );
  const builtinNames = new Set(builtinAgentTools.map((tool) => tool.name));
  const clients: StdioMcpClient[] = [];
  const calls = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();

  const discovered = await Promise.all(
    servers.map(async (server): Promise<ConnectorTool[]> => {
      if (server.transport === "http") {
        if (!server.url) return [];
        const remote = await discoverMcpTools([server.url]);
        return remote.slice(0, CAPABILITY_LIMITS.mcpToolsPerSource).flatMap((tool) => {
          const parsed = parseMcpToolName(tool.name);
          if (!parsed) return [];
          const name = botMcpToolName(server.name, parsed.tool);
          if (builtinNames.has(name) || calls.has(name)) return [];
          calls.set(name, (args) => callMcpTool(server.url!, parsed.tool, args));
          return [{ ...tool, name, description: `${tool.description} (MCP ${server.name})` }];
        });
      }

      if (!server.command) return [];
      const env = serverEnv(server.env);
      const secrets = Object.values(env).filter(Boolean);
      const client = new StdioMcpClient(server.command, server.args, env);
      try {
        const listed = await client.initialize();
        clients.push(client);
        return listed.slice(0, CAPABILITY_LIMITS.mcpToolsPerSource).flatMap((raw) => {
          if (!raw || typeof raw.name !== "string" || !raw.name) return [];
          const tool = sanitizeValue(raw, secrets) as McpToolDescription;
          const name = botMcpToolName(server.name, tool.name);
          if (builtinNames.has(name) || calls.has(name)) return [];
          calls.set(name, async (args) => {
            try {
              return sanitizeValue(await client.call(tool.name, args), secrets);
            } catch (error) {
              throw new Error(failureReason(error, secrets));
            }
          });
          return [
            {
              name,
              description: `${tool.description ?? tool.name} (MCP ${server.name})`,
              inputSchema: tool.inputSchema ?? { type: "object" },
            },
          ];
        });
      } catch (error) {
        const reason = failureReason(error, secrets);
        await client.dispose().catch(() => undefined);
        await options.disable?.(server, reason).catch(() => undefined);
        return [];
      }
    }),
  );

  const tools = discovered.flat().slice(0, maxTools);
  const allowed = new Set(tools.map((tool) => tool.name));
  for (const name of calls.keys()) {
    if (!allowed.has(name)) calls.delete(name);
  }
  return {
    tools,
    has: (name) => calls.has(name),
    async call(name, args) {
      const call = calls.get(name);
      if (!call) return { error: `MCP tool not found for ${name}` };
      return call(args);
    },
    async dispose() {
      await Promise.all(clients.map((client) => client.dispose().catch(() => undefined)));
    },
  };
}
