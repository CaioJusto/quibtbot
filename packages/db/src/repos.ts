import { type Actor, BOT_COLORS, type Bot, type BotGroup } from "@quibt/contracts";
import { inboxBotStatus, nextCronDate } from "@quibt/core";
import type { Prisma, PrismaClient } from "./client.js";
import { ensureDefaultConversation } from "./conversations.js";
import { IsolationError } from "./scope.js";

/**
 * Teto absoluto de bots e de grupos por dono, além de qualquer plano: cada bot carrega
 * um desktop gráfico inteiro no computador compartilhado, e uma lista sem teto vira uma
 * máquina de esgotar disco e memória sem ninguém pedir.
 */
export const MAX_BOTS = 30;
export const MAX_BOT_GROUPS = 30;

function mapBot(
  bot: {
    id: string;
    workspaceId: string;
    name: string;
    title: string;
    description: string;
    instructions: string;
    color: string;
    shape: string;
    notifyOnFinish: boolean;
    parentBotId: string | null;
    pinned?: boolean;
    unread?: boolean;
    autoApprove?: boolean;
    alwaysAllow?: string[];
    chiefOfStaff?: boolean;
    hidden?: boolean;
    activeConversationId?: string | null;
    createdAt: Date;
    updatedAt: Date;
    thread: { id: string } | null;
  },
  preview = "",
  status = "idle",
): Bot {
  if (!bot.thread) {
    throw new IsolationError("Bot is missing its thread");
  }
  return {
    id: bot.id,
    workspaceId: bot.workspaceId,
    name: bot.name,
    title: bot.title,
    description: bot.description,
    instructions: bot.instructions,
    color: bot.color,
    shape: bot.shape || "circle",
    notifyOnFinish: bot.notifyOnFinish,
    parentBotId: bot.parentBotId,
    pinned: bot.pinned ?? false,
    unread: bot.unread ?? false,
    autoApprove: bot.autoApprove ?? true,
    alwaysAllow: bot.alwaysAllow ?? [],
    chiefOfStaff: bot.chiefOfStaff ?? false,
    hidden: bot.hidden ?? false,
    activeConversationId: bot.activeConversationId ?? null,
    threadId: bot.thread.id,
    preview,
    status,
    createdAt: bot.createdAt.toISOString(),
    updatedAt: bot.updatedAt.toISOString(),
  };
}

async function botCardExtras(
  prisma: PrismaClient,
  bot: {
    id: string;
    thread: { id: string } | null;
    desktopSession?: { state: string } | null;
  },
): Promise<{ preview: string; status: string }> {
  if (!bot.thread) return { preview: "", status: "idle" };
  const [last, run] = await Promise.all([
    prisma.message.findFirst({
      where: { threadId: bot.thread.id },
      orderBy: { seq: "desc" },
    }),
    prisma.run.findFirst({
      where: {
        botId: bot.id,
        status: { in: ["running", "queued", "leased", "waiting_input", "waiting_takeover"] },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const blocks = (last?.blocks as Array<{ kind?: string; text?: string }> | undefined) ?? [];
  return {
    preview: blocks.find((block) => block.text)?.text ?? "",
    status: inboxBotStatus({
      runStatus: run?.status,
      computerState: bot.desktopSession?.state,
    }),
  };
}

function mapGroup(group: {
  id: string;
  workspaceId: string;
  name: string;
  instructions: string;
  createdAt: Date;
  updatedAt: Date;
  thread: { id: string } | null;
  members: Array<{
    bot: { id: string; name: string; title: string; color: string; shape: string };
  }>;
}): BotGroup {
  if (!group.thread) throw new IsolationError("Bot group is missing its thread");
  return {
    id: group.id,
    workspaceId: group.workspaceId,
    name: group.name,
    instructions: group.instructions,
    threadId: group.thread.id,
    members: group.members.map(({ bot }) => bot),
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString(),
  };
}

export function createRepos(prisma: PrismaClient) {
  const getOwnedGroup = async (actor: Actor, groupId: string): Promise<BotGroup> => {
    const group = await prisma.botGroup.findFirst({
      where: { id: groupId, workspaceId: actor.workspaceId, userId: actor.userId },
      include: {
        thread: true,
        members: { include: { bot: true }, orderBy: { createdAt: "asc" } },
      },
    });
    if (!group) throw new IsolationError();
    return mapGroup(group);
  };

  const getOwnedBot = async (actor: Actor, botId: string) => {
    const bot = await prisma.bot.findFirst({
      where: { id: botId, workspaceId: actor.workspaceId, userId: actor.userId },
      include: { thread: true, desktopSession: { include: { computer: true } } },
    });
    if (!bot) throw new IsolationError();
    return bot;
  };

  return {
    async listThreadSearchTargets(actor: Actor) {
      const [bots, groups] = await Promise.all([
        prisma.bot.findMany({
          where: { workspaceId: actor.workspaceId, userId: actor.userId },
          select: {
            id: true,
            name: true,
            thread: { select: { id: true } },
          },
        }),
        prisma.botGroup.findMany({
          where: { workspaceId: actor.workspaceId, userId: actor.userId },
          select: {
            id: true,
            name: true,
            thread: { select: { id: true } },
          },
        }),
      ]);

      return [
        ...bots.flatMap((bot) =>
          bot.thread
            ? [
                {
                  threadId: bot.thread.id,
                  botId: bot.id,
                  groupId: null,
                  ownerName: bot.name,
                },
              ]
            : [],
        ),
        ...groups.flatMap((group) =>
          group.thread
            ? [
                {
                  threadId: group.thread.id,
                  botId: null,
                  groupId: group.id,
                  ownerName: group.name,
                },
              ]
            : [],
        ),
      ];
    },

    async listBots(actor: Actor): Promise<Bot[]> {
      const bots = await prisma.bot.findMany({
        where: { workspaceId: actor.workspaceId, userId: actor.userId },
        include: { thread: true, desktopSession: true },
        orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
      });
      const previews = await Promise.all(bots.map((bot) => botCardExtras(prisma, bot)));
      return bots.map((bot, i) => mapBot(bot, previews[i]?.preview, previews[i]?.status));
    },

    async getBot(actor: Actor, botId: string) {
      return getOwnedBot(actor, botId);
    },

    async getBotCard(actor: Actor, botId: string): Promise<Bot> {
      const bot = await getOwnedBot(actor, botId);
      const extras = await botCardExtras(prisma, bot);
      return mapBot(bot, extras.preview, extras.status);
    },

    async createBot(
      actor: Actor,
      input: {
        name: string;
        title: string;
        description: string;
        instructions: string;
        notifyOnFinish: boolean;
        color?: string;
        shape?: string;
        parentBotId?: string | null;
      },
      beforeCreate?: (tx: Prisma.TransactionClient) => Promise<void>,
    ): Promise<Bot> {
      const bot = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${actor.workspaceId}))`;
        await beforeCreate?.(tx);
        if (input.parentBotId) {
          const parent = await tx.bot.findFirst({
            where: {
              id: input.parentBotId,
              workspaceId: actor.workspaceId,
              userId: actor.userId,
            },
          });
          if (!parent) throw new IsolationError();
        }
        const count = await tx.bot.count({
          where: { workspaceId: actor.workspaceId, userId: actor.userId },
        });
        if (count >= MAX_BOTS) {
          throw new IsolationError(
            `Você chegou ao limite de ${MAX_BOTS} bots. Apague um bot que não usa para criar outro.`,
          );
        }
        const color = input.color ?? BOT_COLORS[count % BOT_COLORS.length] ?? BOT_COLORS[0];
        const shape = input.shape ?? "circle";
        const created = await tx.bot.create({
          data: {
            workspaceId: actor.workspaceId,
            userId: actor.userId,
            name: input.name,
            title: input.title,
            description: input.description,
            instructions: input.instructions,
            notifyOnFinish: input.notifyOnFinish,
            color,
            shape,
            parentBotId: input.parentBotId ?? null,
          },
        });
        await tx.thread.create({
          data: {
            workspaceId: actor.workspaceId,
            botId: created.id,
            userId: actor.userId,
          },
        });
        const computer = await tx.computer.upsert({
          where: { workspaceId: actor.workspaceId },
          create: {
            workspaceId: actor.workspaceId,
            userId: actor.userId,
            kind: process.env.SANDBOX_PROVIDER ?? "docker",
            state: "stopped",
          },
          update: {},
        });
        const lastSession = await tx.desktopSession.findFirst({
          where: { computerId: computer.id },
          orderBy: { display: "desc" },
          select: { display: true },
        });
        await tx.desktopSession.create({
          data: {
            workspaceId: actor.workspaceId,
            computerId: computer.id,
            botId: created.id,
            display: (lastSession?.display ?? 0) + 1,
          },
        });
        await tx.agentHome.create({
          data: {
            workspaceId: actor.workspaceId,
            botId: created.id,
            userId: actor.userId,
          },
        });
        await tx.browserProfile.create({
          data: {
            workspaceId: actor.workspaceId,
            botId: created.id,
            userId: actor.userId,
          },
        });
        await tx.memoryDocument.create({
          data: {
            workspaceId: actor.workspaceId,
            userId: actor.userId,
            botId: created.id,
            scope: "bot",
            path: "MEMORY.md",
            content: "",
          },
        });
        await ensureDefaultConversation(tx, created.id, "Conversa");
        return tx.bot.findFirstOrThrow({
          where: { id: created.id },
          include: { thread: true },
        });
      });
      return mapBot(bot);
    },

    async duplicateBot(
      actor: Actor,
      botId: string,
      beforeCreate?: (tx: Prisma.TransactionClient) => Promise<void>,
    ): Promise<Bot> {
      const source = await prisma.bot.findFirst({
        where: { id: botId, workspaceId: actor.workspaceId, userId: actor.userId },
        include: { routines: true },
      });
      if (!source) throw new IsolationError();
      const created = await this.createBot(
        actor,
        {
          name: `${source.name} cópia`,
          title: source.title,
          description: source.description,
          instructions: source.instructions,
          notifyOnFinish: source.notifyOnFinish,
          color: source.color,
          shape: source.shape,
        },
        beforeCreate,
      );
      await prisma.bot.update({
        where: { id: created.id },
        data: {
          autoApprove: source.autoApprove,
          alwaysAllow: source.alwaysAllow,
        },
      });
      if (source.routines.length) {
        const now = new Date();
        await prisma.routine.createMany({
          data: source.routines.map((routine) => ({
            workspaceId: actor.workspaceId,
            botId: created.id,
            userId: actor.userId,
            name: routine.name,
            prompt: routine.prompt,
            cron: routine.cron,
            timezone: routine.timezone,
            active: routine.active,
            notify: routine.notify,
            lastRunAt: null,
            nextRunAt: routine.active ? nextCronDate(routine.cron, now, routine.timezone) : null,
          })),
        });
      }
      const bots = await this.listBots(actor);
      const copy = bots.find((bot) => bot.id === created.id);
      if (!copy) throw new IsolationError();
      return copy;
    },

    async listTeammates(actor: Actor, botId: string): Promise<Bot[]> {
      const source = await prisma.bot.findFirst({
        where: { id: botId, workspaceId: actor.workspaceId, userId: actor.userId },
      });
      if (!source) throw new IsolationError();
      const teammates = await prisma.bot.findMany({
        where: {
          workspaceId: actor.workspaceId,
          userId: actor.userId,
          id: { not: botId },
        },
        include: { thread: true },
        orderBy: { updatedAt: "desc" },
      });
      return teammates.map((bot) => mapBot(bot));
    },

    async listBotGroups(actor: Actor): Promise<BotGroup[]> {
      const groups = await prisma.botGroup.findMany({
        where: { workspaceId: actor.workspaceId, userId: actor.userId },
        include: {
          thread: true,
          members: { include: { bot: true }, orderBy: { createdAt: "asc" } },
        },
        orderBy: { updatedAt: "desc" },
      });
      return groups.map(mapGroup);
    },

    async getBotGroup(actor: Actor, groupId: string): Promise<BotGroup> {
      return getOwnedGroup(actor, groupId);
    },

    async createBotGroup(
      actor: Actor,
      input: { name: string; botIds: string[] },
    ): Promise<BotGroup> {
      const botIds = [...new Set(input.botIds)];
      const owned = await prisma.bot.findMany({
        where: { id: { in: botIds }, workspaceId: actor.workspaceId, userId: actor.userId },
        select: { id: true },
      });
      if (owned.length !== botIds.length) throw new IsolationError();
      const group = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${actor.workspaceId}))`;
        const groups = await tx.botGroup.count({
          where: { workspaceId: actor.workspaceId, userId: actor.userId },
        });
        if (groups >= MAX_BOT_GROUPS) {
          throw new IsolationError(
            `Você chegou ao limite de ${MAX_BOT_GROUPS} grupos. Apague um grupo que não usa para criar outro.`,
          );
        }
        const created = await tx.botGroup.create({
          data: { workspaceId: actor.workspaceId, userId: actor.userId, name: input.name },
        });
        await tx.thread.create({
          data: {
            workspaceId: actor.workspaceId,
            userId: actor.userId,
            botGroupId: created.id,
          },
        });
        if (botIds.length) {
          await tx.botGroupMember.createMany({
            data: botIds.map((botId) => ({ groupId: created.id, botId })),
          });
        }
        return created;
      });
      return getOwnedGroup(actor, group.id);
    },

    async updateBotGroup(
      actor: Actor,
      groupId: string,
      data: { name?: string; instructions?: string },
    ): Promise<BotGroup> {
      await getOwnedGroup(actor, groupId);
      await prisma.botGroup.update({
        where: { id: groupId },
        data: { name: data.name, instructions: data.instructions },
      });
      return getOwnedGroup(actor, groupId);
    },

    async removeBotGroup(actor: Actor, groupId: string): Promise<void> {
      await getOwnedGroup(actor, groupId);
      await prisma.botGroup.delete({ where: { id: groupId } });
    },

    async addBotGroupMember(actor: Actor, groupId: string, botId: string): Promise<BotGroup> {
      await getOwnedGroup(actor, groupId);
      const bot = await prisma.bot.findFirst({
        where: { id: botId, workspaceId: actor.workspaceId, userId: actor.userId },
      });
      if (!bot) throw new IsolationError();
      await prisma.botGroupMember.upsert({
        where: { groupId_botId: { groupId, botId } },
        create: { groupId, botId },
        update: {},
      });
      return getOwnedGroup(actor, groupId);
    },

    async removeBotGroupMember(actor: Actor, groupId: string, botId: string): Promise<BotGroup> {
      await getOwnedGroup(actor, groupId);
      await prisma.botGroupMember.deleteMany({ where: { groupId, botId } });
      return getOwnedGroup(actor, groupId);
    },
  };
}
