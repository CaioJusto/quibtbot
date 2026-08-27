import type { Actor, MessageBlock } from "@quibt/contracts";
import { mentionTargets } from "@quibt/core";
import type { Prisma, PrismaClient } from "./client.js";
import { isRunNonceConflict } from "./errors.js";
import { appendEvent } from "./events.js";
import { IsolationError } from "./scope.js";

type Trigger = "user" | "follow_up" | "peer" | "group" | "routine";

export async function appendThreadMessage(
  prisma: PrismaClient,
  input: {
    threadId: string;
    role: "user" | "bot" | "system";
    blocks: MessageBlock[];
    runId?: string;
    fromBotId?: string;
    authorBotId?: string;
    conversationId?: string | null;
    parentId?: string | null;
    replyToId?: string | null;
  },
) {
  return prisma.$transaction(async (tx) => createMessage(tx, input));
}

export async function createPeerWake(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    fromBotId: string;
    toBotId: string;
    text: string;
    /**
     * Causal webhook origin to carry into the new run's `webhookId` column. The run's own
     * `trigger` always stays "peer" here — an ordinary teammate hop is still an ordinary
     * teammate hop — so `run.trigger === "peer"` keeps meaning exactly that everywhere else
     * in the codebase (e.g. the executor's ask_bot tool filter). Only the origin, carried in
     * `webhookId`, survives the hop, including a peer that itself asks another peer.
     */
    webhookId?: string | null;
  },
) {
  if (input.fromBotId === input.toBotId) throw new IsolationError("A bot cannot message itself");
  const bots = await prisma.bot.findMany({
    where: {
      id: { in: [input.fromBotId, input.toBotId] },
      workspaceId: actor.workspaceId,
      userId: actor.userId,
    },
    include: { thread: true },
  });
  const sender = bots.find((bot) => bot.id === input.fromBotId);
  const target = bots.find((bot) => bot.id === input.toBotId);
  if (!sender || !target?.thread) throw new IsolationError();
  const conversation = target.activeConversationId
    ? await prisma.conversation.findUnique({ where: { id: target.activeConversationId } })
    : await prisma.conversation.findFirst({
        where: { botId: target.id },
        orderBy: { createdAt: "asc" },
      });
  const peerCue = `[peer] Recado de ${sender.name}:\n${input.text}`;

  const result = await prisma.$transaction(async (tx) => {
    const message = await createMessage(tx, {
      threadId: target.thread!.id,
      conversationId: conversation?.id,
      parentId: conversation?.activeLeafId,
      role: "system",
      blocks: [{ kind: "text", text: peerCue }],
      fromBotId: sender.id,
    });
    const { task, run } = await createRun(tx, {
      actor,
      botId: target.id,
      threadId: target.thread!.id,
      prompt: peerCue,
      trigger: "peer",
      webhookId: input.webhookId ?? null,
    });
    return { message, task, run };
  });
  await prisma.bot.update({
    where: { id: target.id },
    data: { unread: true, updatedAt: new Date() },
  });
  await appendEvent(prisma, {
    workspaceId: actor.workspaceId,
    threadId: target.thread.id,
    botId: target.id,
    type: "thread.message.created",
    payload: {
      messageId: result.message.id,
      role: "system",
      blocks: [{ kind: "text", text: peerCue }],
      fromBotId: sender.id,
    },
  });
  return { ...result, targetBotId: target.id };
}

export async function createGroupWakes(
  prisma: PrismaClient,
  actor: Actor,
  input: { groupId: string; text: string; clientNonce?: string; mentionBotIds?: string[] },
) {
  const group = await prisma.botGroup.findFirst({
    where: { id: input.groupId, workspaceId: actor.workspaceId, userId: actor.userId },
    include: { thread: true, members: { include: { bot: true } } },
  });
  if (!group?.thread) throw new IsolationError();

  const targetIds = new Set(
    mentionTargets(
      group.members.map((member) => ({ botId: member.botId, name: member.bot.name })),
      input.text,
      input.mentionBotIds,
    ),
  );

  const existingWakes = async (tx: Prisma.TransactionClient | PrismaClient) => {
    if (!input.clientNonce) return [];
    return tx.run.findMany({
      where: {
        workspaceId: actor.workspaceId,
        clientNonce: { startsWith: `${input.clientNonce}:` },
      },
      orderBy: { createdAt: "asc" },
    });
  };

  const duplicateOf = async (
    runs: Awaited<ReturnType<typeof existingWakes>>,
  ): Promise<{
    seq: number;
    runs: typeof runs;
    message: null;
    duplicate: true;
  }> => {
    const lastUser = await prisma.message.findFirst({
      where: { threadId: group.thread!.id, role: "user" },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    return { seq: lastUser?.seq ?? -1, runs, message: null, duplicate: true };
  };

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await existingWakes(tx);
      if (existing.length) {
        return { seq: -1, runs: existing, message: null, duplicate: true as const };
      }
      const message = await createMessage(tx, {
        threadId: group.thread!.id,
        role: "user",
        blocks: [{ kind: "text", text: input.text }],
      });
      const runs = [];
      for (const member of group.members) {
        if (!targetIds.has(member.botId)) continue;
        const created = await createRun(tx, {
          actor,
          botId: member.botId,
          threadId: group.thread!.id,
          prompt: input.text,
          trigger: "group",
          clientNonce: input.clientNonce ? `${input.clientNonce}:${member.botId}` : undefined,
        });
        runs.push(created.run);
      }
      return { seq: message.seq, runs, message, duplicate: false as const };
    });
    if (result.duplicate) return duplicateOf(result.runs);
    await appendEvent(prisma, {
      workspaceId: actor.workspaceId,
      threadId: group.thread.id,
      type: "thread.message.created",
      payload: {
        messageId: result.message.id,
        ...(input.clientNonce ? { clientNonce: input.clientNonce } : {}),
        role: "user",
        blocks: [{ kind: "text", text: input.text }],
      },
    });
    return result;
  } catch (error) {
    if (!input.clientNonce || !isRunNonceConflict(error)) throw error;
    const existing = await existingWakes(prisma);
    if (!existing.length) throw error;
    return duplicateOf(existing);
  }
}

export async function createGroupRoutineWakes(
  prisma: PrismaClient,
  input: {
    groupId: string;
    workspaceId: string;
    userId: string;
    prompt: string;
    routineId: string;
    /**
     * Runs inside the same transaction as the group's runs, so the caller can mark the
     * routine as fired atomically: a crash between the two writes let the retry fire the
     * same tick again and create a second run per member.
     */
    mark?: (tx: Prisma.TransactionClient) => Promise<void>;
    /** Runs after the member runs commit, so the next tick is scheduled once. */
    schedule?: () => Promise<void>;
  },
) {
  const group = await prisma.botGroup.findFirst({
    where: { id: input.groupId, workspaceId: input.workspaceId, userId: input.userId },
    include: { thread: true, members: true },
  });
  if (!group?.thread) throw new IsolationError();
  const actor: Actor = {
    userId: input.userId,
    workspaceId: input.workspaceId,
    workspaceRole: "member",
    email: "",
    isDeploymentOwner: false,
  };
  const runs = await prisma.$transaction(async (tx) => {
    const createdRuns = [];
    for (const member of group.members) {
      const created = await createRun(tx, {
        actor,
        botId: member.botId,
        threadId: group.thread!.id,
        prompt: input.prompt,
        trigger: "routine",
        routineId: input.routineId,
      });
      createdRuns.push(created.run);
    }
    await input.mark?.(tx);
    return createdRuns;
  });
  await input.schedule?.();
  return runs;
}

async function createMessage(
  tx: Prisma.TransactionClient,
  input: {
    threadId: string;
    role: "user" | "bot" | "system";
    blocks: MessageBlock[];
    runId?: string;
    fromBotId?: string;
    authorBotId?: string;
    conversationId?: string | null;
    parentId?: string | null;
    replyToId?: string | null;
  },
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.threadId}))`;
  const last = await tx.message.findFirst({
    where: { threadId: input.threadId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  const created = await tx.message.create({
    data: {
      threadId: input.threadId,
      conversationId: input.conversationId ?? undefined,
      parentId: input.parentId ?? undefined,
      replyToId: input.replyToId ?? undefined,
      seq: (last?.seq ?? -1) + 1,
      role: input.role,
      blocks: input.blocks as Prisma.InputJsonValue,
      runId: input.runId,
      fromBotId: input.fromBotId,
      authorBotId: input.authorBotId,
    },
  });
  if (input.conversationId) {
    await tx.conversation.update({
      where: { id: input.conversationId },
      data: { activeLeafId: created.id, updatedAt: new Date() },
    });
  }
  return created;
}

async function createRun(
  tx: Prisma.TransactionClient,
  input: {
    actor: Actor;
    botId: string;
    threadId: string;
    prompt: string;
    trigger: Trigger;
    clientNonce?: string;
    webhookId?: string | null;
    routineId?: string | null;
  },
) {
  const task = await tx.task.create({
    data: {
      workspaceId: input.actor.workspaceId,
      botId: input.botId,
      threadId: input.threadId,
      userId: input.actor.userId,
      prompt: input.prompt,
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      workspaceId: input.actor.workspaceId,
      botId: input.botId,
      threadId: input.threadId,
      taskId: task.id,
      userId: input.actor.userId,
      status: "queued",
      trigger: input.trigger,
      clientNonce: input.clientNonce,
      webhookId: input.webhookId ?? undefined,
      routineId: input.routineId ?? undefined,
    },
  });
  return { task, run };
}
