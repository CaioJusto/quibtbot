import { UNTITLED_TASK } from "@quibt/core";
import type { Prisma, PrismaClient } from "./client.js";

export function mapConversation(row: {
  id: string;
  botId: string;
  title: string;
  activeLeafId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    botId: row.botId,
    title: row.title,
    activeLeafId: row.activeLeafId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function ensureDefaultConversation(
  prisma: PrismaClient | Prisma.TransactionClient,
  botId: string,
  title = UNTITLED_TASK,
) {
  const existing = await prisma.conversation.findFirst({
    where: { botId },
    orderBy: { createdAt: "asc" },
  });
  if (existing) {
    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      select: { activeConversationId: true },
    });
    if (!bot?.activeConversationId) {
      await prisma.bot.update({
        where: { id: botId },
        data: { activeConversationId: existing.id },
      });
    }
    return existing;
  }
  const created = await prisma.conversation.create({
    data: { botId, title },
  });
  await prisma.bot.update({
    where: { id: botId },
    data: { activeConversationId: created.id },
  });
  await prisma.message.updateMany({
    where: { thread: { botId }, conversationId: null },
    data: { conversationId: created.id },
  });
  return created;
}

export async function activeConversationForBot(
  prisma: PrismaClient | Prisma.TransactionClient,
  botId: string,
) {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: { activeConversationId: true },
  });
  if (bot?.activeConversationId) {
    const current = await prisma.conversation.findUnique({
      where: { id: bot.activeConversationId },
    });
    if (current) return current;
  }
  return ensureDefaultConversation(prisma, botId);
}
