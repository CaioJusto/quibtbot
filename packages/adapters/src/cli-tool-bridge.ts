import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import type { AgentRuntimeEvent, ConnectorTool } from "@quibt/adapter-kit";
import { ApprovalPause } from "./approval-wait.js";
import { isPermissionRequiredError, type PermissionAsk } from "./permissions.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";
export const CLI_MCP_SERVER_NAME = "quibt";

export type CliToolBridge = {
  port: number;
  close(): Promise<void>;
};

export type CliToolBridgeHandlers = {
  tools: ConnectorTool[];
  executeTool?: (
    name: string,
    args: Record<string, unknown>,
    executionId: string,
  ) => Promise<unknown>;
  onTool?: (event: { name: string; args: Record<string, unknown>; executionId: string }) => void;
  onPermission?: (ask: PermissionAsk) => void;
  onPause?: () => void;
  nextExecutionId: (name: string) => string;
};

type RpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
};

export function createRuntimeEventQueue() {
  const items: AgentRuntimeEvent[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    push(event: AgentRuntimeEvent) {
      const last = items.at(-1);
      if (event.type === "text" && last?.type === "text") {
        last.text += event.text;
        wake?.();
        return;
      }
      items.push(event);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *iterate(): AsyncIterable<AgentRuntimeEvent> {
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

export async function startCliToolBridge(handlers: CliToolBridgeHandlers): Promise<CliToolBridge> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    attachMcpClient(socket, handlers);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("CLI tool bridge failed to bind a local port");
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

export async function writeCliMcpProxy(dir: string, port: number): Promise<string> {
  const file = path.join(dir, "quibt-mcp-proxy.mjs");
  await writeFile(
    file,
    `import net from "node:net";
const socket = net.connect({ host: "127.0.0.1", port: ${port} });
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on("error", (error) => {
  process.stderr.write(String(error?.message ?? error) + "\\n");
  process.exit(1);
});
socket.on("close", () => process.exit(0));
process.stdin.resume();
`,
    "utf8",
  );
  return file;
}

export async function writeCliMcpConfig(
  dir: string,
  command: string,
  args: string[],
): Promise<string> {
  const file = path.join(dir, "quibt-mcp.json");
  await writeFile(
    file,
    `${JSON.stringify(
      {
        mcpServers: {
          [CLI_MCP_SERVER_NAME]: { command, args },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await mkdir(path.join(dir, ".grok"), { recursive: true });
  await writeFile(
    path.join(dir, ".grok", "config.toml"),
    `[mcp_servers.${CLI_MCP_SERVER_NAME}]
command = ${JSON.stringify(command)}
args = ${JSON.stringify(args)}
`,
    "utf8",
  );
  return file;
}

function attachMcpClient(socket: Socket, handlers: CliToolBridgeHandlers): void {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const parsed = takeContentLengthFrame(buffer);
      if (!parsed) break;
      buffer = Buffer.from(parsed.rest);
      void handleMcpMessage(socket, parsed.message, handlers);
    }
  });
  socket.on("error", () => undefined);
}

export function takeContentLengthFrame(
  buffer: Buffer,
): { message: RpcMessage; rest: Buffer } | null {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd < 0) return null;
  const header = buffer.subarray(0, headerEnd).toString("ascii");
  const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
  if (!match) return { message: {}, rest: buffer.subarray(headerEnd + 4) };
  const length = Number(match[1]);
  const bodyStart = headerEnd + 4;
  if (buffer.length < bodyStart + length) return null;
  const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
  const rest = buffer.subarray(bodyStart + length);
  try {
    return { message: JSON.parse(body) as RpcMessage, rest };
  } catch {
    return { message: {}, rest };
  }
}

export function encodeContentLength(message: unknown): Buffer {
  const body = JSON.stringify(message);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

async function handleMcpMessage(
  socket: Socket,
  message: RpcMessage,
  handlers: CliToolBridgeHandlers,
): Promise<void> {
  if (message.method === "notifications/initialized" || message.id === undefined) return;
  if (message.method === "initialize") {
    writeRpc(socket, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "quibt-computer", version: "1" },
      },
    });
    return;
  }
  if (message.method === "ping") {
    writeRpc(socket, { jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "tools/list") {
    writeRpc(socket, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: handlers.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema ?? { type: "object" },
        })),
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    const name = String(message.params?.name ?? "");
    const args =
      message.params?.arguments && typeof message.params.arguments === "object"
        ? (message.params.arguments as Record<string, unknown>)
        : {};
    const executionId = handlers.nextExecutionId(name);
    handlers.onTool?.({ name, args, executionId });
    try {
      if (!handlers.executeTool) {
        writeRpc(socket, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{ type: "text", text: `${name} is unavailable without an executor.` }],
            isError: true,
          },
        });
        return;
      }
      const result = await handlers.executeTool(name, args, executionId);
      writeRpc(socket, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: stringifyToolResult(result) }],
        },
      });
    } catch (error) {
      if (isPermissionRequiredError(error)) {
        handlers.onPermission?.(error.permission);
        writeRpc(socket, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{ type: "text", text: "Preciso da sua aprovação" }],
            isError: true,
          },
        });
        return;
      }
      if (error instanceof ApprovalPause) {
        handlers.onPause?.();
        writeRpc(socket, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{ type: "text", text: error.waitingText }],
            isError: true,
          },
        });
        return;
      }
      writeRpc(socket, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        },
      });
    }
    return;
  }
  writeRpc(socket, {
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `Unknown method ${message.method ?? ""}` },
  });
}

function writeRpc(socket: Socket, message: unknown): void {
  socket.write(encodeContentLength(message));
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}
