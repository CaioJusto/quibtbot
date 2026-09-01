import { BOT_OPENAPI_LIMITS, type BotOpenApiSource } from "@quibt/contracts";
import type { PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";

const CREDENTIAL_QUERY_KEY =
  /(^|[_-])(access[_-]?token|api[_-]?key|auth|authorization|credential|password|secret|signature|token)([_-]|$)/i;

export type BotOpenApiSourceInput = {
  workspaceId: string;
  botId: string;
  name: unknown;
  url: unknown;
};

export type ValidatedBotOpenApiInput = {
  workspaceId: string;
  botId: string;
  name: string;
  url: string;
};

export class BotOpenApiSourceError extends Error {
  constructor(
    readonly code: "invalid" | "limit" | "duplicate",
    message: string,
  ) {
    super(message);
    this.name = "BotOpenApiSourceError";
  }
}

function invalid(message: string): never {
  throw new BotOpenApiSourceError("invalid", message);
}

/** Pure URL-shape validation. DNS/private-address checks live at the outbound API boundary. */
export function validateBotOpenApiInput(input: BotOpenApiSourceInput): ValidatedBotOpenApiInput {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > BOT_OPENAPI_LIMITS.nameChars) {
    invalid("OpenAPI source name is invalid");
  }
  const source = typeof input.url === "string" ? input.url.trim() : "";
  if (!source || source.length > BOT_OPENAPI_LIMITS.urlChars) {
    invalid("OpenAPI URL is outside the limit");
  }
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return invalid("OpenAPI URL must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    invalid("OpenAPI URL must use HTTPS without embedded credentials");
  }
  if ([...url.searchParams.keys()].some((key) => CREDENTIAL_QUERY_KEY.test(key))) {
    invalid("OpenAPI URL must not contain credential query parameters");
  }
  url.hash = "";
  return { workspaceId: input.workspaceId, botId: input.botId, name, url: url.toString() };
}

type PublicBotOpenApiRow = {
  id: string;
  botId: string;
  name: string;
  url: string;
  enabled: boolean;
  disabledReason: string | null;
  createdAt: Date | string;
};

export function mapBotOpenApiSource(row: PublicBotOpenApiRow): BotOpenApiSource {
  return {
    id: row.id,
    botId: row.botId,
    name: row.name,
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
  url: true,
  enabled: true,
  disabledReason: true,
  createdAt: true,
} as const;

export async function addBotOpenApiSource(prisma: PrismaClient, input: BotOpenApiSourceInput) {
  const value = validateBotOpenApiInput(input);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`bot-openapi:${value.workspaceId}:${value.botId}`}))`;
    const bot = await tx.bot.findFirst({
      where: { id: value.botId, workspaceId: value.workspaceId },
      select: { id: true },
    });
    if (!bot) throw new IsolationError();
    const rows = await tx.botOpenApiSource.findMany({
      where: { workspaceId: value.workspaceId, botId: value.botId },
      select: { id: true, name: true },
      take: BOT_OPENAPI_LIMITS.sourcesPerBot + 1,
    });
    if (rows.some((row) => row.name === value.name)) {
      throw new BotOpenApiSourceError(
        "duplicate",
        "An OpenAPI source with this name already exists",
      );
    }
    if (rows.length >= BOT_OPENAPI_LIMITS.sourcesPerBot) {
      throw new BotOpenApiSourceError(
        "limit",
        `OpenAPI source limit reached (${BOT_OPENAPI_LIMITS.sourcesPerBot})`,
      );
    }
    const row = await tx.botOpenApiSource.create({
      data: value,
      select: publicSelect,
    });
    return mapBotOpenApiSource(row);
  });
}

export async function listBotOpenApiSources(
  prisma: PrismaClient,
  scope: { workspaceId: string; botId: string },
) {
  const rows = await prisma.botOpenApiSource.findMany({
    where: { workspaceId: scope.workspaceId, botId: scope.botId },
    select: publicSelect,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: BOT_OPENAPI_LIMITS.sourcesPerBot,
  });
  return rows.map(mapBotOpenApiSource);
}

export async function removeBotOpenApiSource(
  prisma: PrismaClient,
  scope: { workspaceId: string; botId: string; id: string },
) {
  return prisma.botOpenApiSource.deleteMany({
    where: { id: scope.id, workspaceId: scope.workspaceId, botId: scope.botId },
  });
}

export async function disableBotOpenApiSource(
  prisma: PrismaClient,
  scope: { workspaceId: string; botId: string; id: string; reason: string },
) {
  return prisma.botOpenApiSource.updateMany({
    where: { id: scope.id, workspaceId: scope.workspaceId, botId: scope.botId },
    data: { enabled: false, disabledReason: scope.reason.replace(/[\r\n]+/g, " ").slice(0, 240) },
  });
}
