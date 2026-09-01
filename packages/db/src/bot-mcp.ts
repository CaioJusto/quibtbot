import { BOT_MCP_LIMITS, type BotMcpServer } from "@quibt/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";

export type BotMcpServerInput = {
  workspaceId: string;
  botId: string;
  name: string;
  command?: unknown;
  args?: unknown;
  url?: unknown;
  env?: unknown;
};

export type ValidatedBotMcpInput = {
  workspaceId: string;
  botId: string;
  name: string;
  transport: "stdio" | "http";
  command: string | null;
  args: string[];
  url: string | null;
  env?: Record<string, string>;
};

export class BotMcpServerError extends Error {
  constructor(
    readonly code: "invalid" | "limit" | "duplicate",
    message: string,
  ) {
    super(message);
    this.name = "BotMcpServerError";
  }
}

function invalid(message: string): never {
  throw new BotMcpServerError("invalid", message);
}

function validateHttpsUrl(value: string): string {
  if (!value || value.length > BOT_MCP_LIMITS.urlChars) invalid("MCP URL is outside the limit");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalid("MCP URL must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    invalid("MCP URL must use HTTPS without embedded credentials");
  }
  return parsed.toString();
}

/** Validates argv and HTTPS shape without doing DNS or opening a database connection. */
export function validateBotMcpInput(input: BotMcpServerInput): ValidatedBotMcpInput {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > BOT_MCP_LIMITS.nameChars) invalid("MCP server name is invalid");

  const hasCommand = typeof input.command === "string" && input.command.length > 0;
  const hasUrl = typeof input.url === "string" && input.url.length > 0;
  if (hasCommand === hasUrl) invalid("Provide either an MCP command or HTTPS URL");

  if (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== "string")) {
    invalid("MCP arguments must be an array of strings");
  }
  const args = input.args as string[];
  if (
    args.length > BOT_MCP_LIMITS.args ||
    args.some((arg) => arg.length > BOT_MCP_LIMITS.argChars || arg.includes("\0"))
  ) {
    invalid("MCP arguments are outside the limit");
  }

  let env: Record<string, string> | undefined;
  if (input.env !== undefined) {
    if (!input.env || Array.isArray(input.env) || typeof input.env !== "object") {
      invalid("MCP environment must be a string-to-string map");
    }
    const entries = Object.entries(input.env as Record<string, unknown>);
    if (
      entries.length > BOT_MCP_LIMITS.envKeys ||
      entries.some(
        ([key, value]) =>
          !key ||
          key.length > BOT_MCP_LIMITS.envKeyChars ||
          typeof value !== "string" ||
          value.length > BOT_MCP_LIMITS.envValueChars ||
          key.includes("\0") ||
          (typeof value === "string" && value.includes("\0")),
      )
    ) {
      invalid("MCP environment must contain bounded string keys and values");
    }
    env = Object.fromEntries(entries) as Record<string, string>;
    if (new TextEncoder().encode(JSON.stringify(env)).byteLength > BOT_MCP_LIMITS.envBytes) {
      invalid("MCP environment is too large");
    }
  }

  if (hasCommand) {
    const command = input.command as string;
    if (
      command.length > BOT_MCP_LIMITS.commandChars ||
      /\s/.test(command) ||
      /[;&|`$<>(){}[\]!*?'"\\]/.test(command) ||
      command.includes("\0")
    ) {
      invalid("MCP command must be one executable argv value; put flags in arguments");
    }
    return {
      workspaceId: input.workspaceId,
      botId: input.botId,
      name,
      transport: "stdio",
      command,
      args,
      url: null,
      ...(env ? { env } : {}),
    };
  }

  return {
    workspaceId: input.workspaceId,
    botId: input.botId,
    name,
    transport: "http",
    command: null,
    args: [],
    url: validateHttpsUrl(input.url as string),
    ...(env ? { env } : {}),
  };
}

type PublicBotMcpRow = {
  id: string;
  botId: string;
  name: string;
  transport: string;
  command: string | null;
  args: string[];
  url: string | null;
  enabled: boolean;
  disabledReason: string | null;
  createdAt: Date | string;
};

/** An explicit projection makes it impossible for `env` to escape through serialization. */
export function mapBotMcpServer(row: PublicBotMcpRow): BotMcpServer {
  return {
    id: row.id,
    botId: row.botId,
    name: row.name,
    transport: row.transport === "http" ? "http" : "stdio",
    command: row.command,
    args: row.args,
    url: row.url,
    enabled: row.enabled,
    disabledReason: row.disabledReason,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

const publicSelect = {
  id: true,
  botId: true,
  name: true,
  transport: true,
  command: true,
  args: true,
  url: true,
  enabled: true,
  disabledReason: true,
  createdAt: true,
} as const;

export async function addBotMcpServer(prisma: PrismaClient, input: BotMcpServerInput) {
  const value = validateBotMcpInput(input);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`bot-mcp:${value.workspaceId}:${value.botId}`}))`;
    const bot = await tx.bot.findFirst({
      where: { id: value.botId, workspaceId: value.workspaceId },
      select: { id: true },
    });
    if (!bot) throw new IsolationError();
    const rows = await tx.botMcpServer.findMany({
      where: { workspaceId: value.workspaceId, botId: value.botId },
      select: { id: true, name: true },
      take: BOT_MCP_LIMITS.serversPerBot + 1,
    });
    if (rows.some((row) => row.name === value.name)) {
      throw new BotMcpServerError("duplicate", "An MCP server with this name already exists");
    }
    if (rows.length >= BOT_MCP_LIMITS.serversPerBot) {
      throw new BotMcpServerError(
        "limit",
        `MCP server limit reached (${BOT_MCP_LIMITS.serversPerBot})`,
      );
    }
    const row = await tx.botMcpServer.create({
      data: {
        workspaceId: value.workspaceId,
        botId: value.botId,
        name: value.name,
        transport: value.transport,
        command: value.command,
        args: value.args,
        url: value.url,
        ...(value.env ? { env: value.env as Prisma.InputJsonValue } : {}),
      },
      select: publicSelect,
    });
    return mapBotMcpServer(row);
  });
}

export async function listBotMcpServers(
  prisma: PrismaClient,
  scope: { workspaceId: string; botId: string },
) {
  const rows = await prisma.botMcpServer.findMany({
    where: { workspaceId: scope.workspaceId, botId: scope.botId },
    select: publicSelect,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: BOT_MCP_LIMITS.serversPerBot,
  });
  return rows.map(mapBotMcpServer);
}

export async function removeBotMcpServer(
  prisma: PrismaClient,
  scope: { workspaceId: string; botId: string; id: string },
) {
  return prisma.botMcpServer.deleteMany({
    where: { id: scope.id, workspaceId: scope.workspaceId, botId: scope.botId },
  });
}

export async function disableBotMcpServer(
  prisma: PrismaClient,
  scope: { workspaceId: string; botId: string; id: string; reason: string },
) {
  return prisma.botMcpServer.updateMany({
    where: { id: scope.id, workspaceId: scope.workspaceId, botId: scope.botId },
    data: { enabled: false, disabledReason: scope.reason.slice(0, 240) },
  });
}
