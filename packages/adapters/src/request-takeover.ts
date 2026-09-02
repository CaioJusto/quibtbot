import type { NotificationMessage, NotificationProvider } from "@quibt/adapter-kit";

export const WAITING_TAKEOVER_STATUS = "waiting_takeover" as const;

export function parkedDesktopForTakeover(): {
  state: "running";
  controlHolder: "none";
  waitingTakeover: true;
} {
  return { state: "running", controlHolder: "none", waitingTakeover: true };
}

export function agentComputerUseAllowed(session: {
  state?: string | null;
  controlHolder?: string | null;
  waitingTakeover?: boolean | null;
}): boolean {
  return session.state === "running" && session.controlHolder === "bot" && !session.waitingTakeover;
}

export function takeoverNotice(input: {
  botName: string;
  botId: string;
  threadId: string;
  reason: string;
}): NotificationMessage {
  return {
    kind: "takeover",
    title: `${input.botName} precisa de você na tela`,
    body: input.reason,
    botId: input.botId,
    threadId: input.threadId,
  };
}

export interface RequestTakeoverDb {
  desktopSession: {
    updateMany(args: {
      where: { botId: string };
      data: { state: string; controlHolder: string; waitingTakeover: boolean };
    }): Promise<{ count: number }>;
  };
  run: {
    update(args: { where: { id: string }; data: { status: string } }): Promise<unknown>;
  };
}

export async function applyRequestTakeover(input: {
  prisma: RequestTakeoverDb;
  notifications?: Pick<NotificationProvider, "send">;
  bot: { id: string; name: string };
  run: { id: string; workspaceId: string; userId: string; botId: string; threadId: string };
  reason: string;
}): Promise<{ status: "waiting_takeover" }> {
  await input.prisma.desktopSession.updateMany({
    where: { botId: input.bot.id },
    data: parkedDesktopForTakeover(),
  });
  await input.prisma.run.update({
    where: { id: input.run.id },
    data: { status: WAITING_TAKEOVER_STATUS },
  });
  const message = takeoverNotice({
    botName: input.bot.name,
    botId: input.bot.id,
    threadId: input.run.threadId,
    reason: input.reason,
  });
  if (input.notifications) {
    await input.notifications
      .send(message, {
        operationId: "notify",
        traceId: input.run.botId,
        workspaceId: input.run.workspaceId,
        userId: input.run.userId,
        botId: input.run.botId,
        signal: new AbortController().signal,
      })
      .catch(() => undefined);
  }
  return { status: WAITING_TAKEOVER_STATUS };
}

export async function clearWaitingTakeover(
  prisma: {
    desktopSession: {
      updateMany(args: {
        where: { botId: string };
        data: { waitingTakeover: boolean };
      }): Promise<{ count: number }>;
    };
  },
  botId: string,
): Promise<void> {
  await prisma.desktopSession.updateMany({
    where: { botId },
    data: { waitingTakeover: false },
  });
}
