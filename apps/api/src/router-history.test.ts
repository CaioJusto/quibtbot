import { call } from "@orpc/server";
import type { Actor } from "@quibt/contracts";
import type { PrismaClient } from "@quibt/db";
import { describe, expect, it } from "vitest";
import {
  createRouter,
  historyWindow,
  type RouterDeps,
  THREAD_HISTORY_DEFAULT_LIMIT,
} from "./router.js";

const owner: Actor = {
  userId: "user-1",
  workspaceId: "ws-1",
  workspaceRole: "owner",
  email: "owner@example.com",
  isDeploymentOwner: true,
};

const outsider: Actor = {
  userId: "user-2",
  workspaceId: "ws-2",
  workspaceRole: "owner",
  email: "other@example.com",
  isDeploymentOwner: false,
};

function harness(options: { unread?: boolean } = {}) {
  const now = new Date("2026-08-26T12:00:00Z");
  const conversation = {
    id: "conversation-1",
    botId: "bot-1",
    title: "History",
    activeLeafId: null,
    createdAt: now,
    updatedAt: now,
  };
  const bot = {
    id: "bot-1",
    workspaceId: owner.workspaceId,
    userId: owner.userId,
    thread: { id: "thread-1" },
    desktopSession: null,
    activeConversationId: conversation.id,
    unread: options.unread ?? false,
  };
  const group = {
    id: "group-1",
    workspaceId: owner.workspaceId,
    userId: owner.userId,
    name: "Team",
    instructions: "",
    thread: { id: "group-thread-1" },
    members: [],
    createdAt: now,
    updatedAt: now,
  };
  const messages = new Map(
    ["thread-1", "group-thread-1"].map((threadId) => [
      threadId,
      Array.from({ length: 120 }, (_, seq) => ({
        id: `${threadId}-message-${seq}`,
        threadId,
        conversationId: threadId === "thread-1" ? conversation.id : null,
        parentId: null,
        seq,
        role: seq % 2 ? "bot" : "user",
        blocks: [{ kind: "text", text: `message ${seq}` }],
        runId: null,
        fromBotId: null,
        authorBotId: null,
        replyToId: null,
        reactions: {},
        createdAt: new Date(now.getTime() + seq),
      })),
    ]),
  );
  const messageQueries: Array<Record<string, unknown>> = [];
  const botUpdates: Array<Record<string, unknown>> = [];
  const botScopes: Array<Record<string, unknown>> = [];
  const groupScopes: Array<Record<string, unknown>> = [];

  const prisma = {
    bot: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        botScopes.push(args.where);
        return args.where.id === bot.id &&
          args.where.workspaceId === owner.workspaceId &&
          args.where.userId === owner.userId
          ? bot
          : null;
      },
      findUnique: async () => ({ activeConversationId: conversation.id }),
      update: async (args: { data: Record<string, unknown> }) => {
        botUpdates.push(args.data);
        bot.unread = false;
        return bot;
      },
    },
    botGroup: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        groupScopes.push(args.where);
        return args.where.id === group.id &&
          args.where.workspaceId === owner.workspaceId &&
          args.where.userId === owner.userId
          ? group
          : null;
      },
    },
    conversation: {
      findUnique: async () => conversation,
      findMany: async () => [conversation],
    },
    message: {
      findMany: async (args: {
        where: { threadId: string; seq?: { gt?: number; lt?: number } };
        orderBy: { seq: "asc" | "desc" };
        take?: number;
      }) => {
        messageQueries.push(args as unknown as Record<string, unknown>);
        let rows = [...(messages.get(args.where.threadId) ?? [])];
        if (args.where.seq?.gt !== undefined) {
          rows = rows.filter((row) => row.seq > args.where.seq!.gt!);
        }
        if (args.where.seq?.lt !== undefined) {
          rows = rows.filter((row) => row.seq < args.where.seq!.lt!);
        }
        rows.sort((a, b) => (args.orderBy.seq === "asc" ? a.seq - b.seq : b.seq - a.seq));
        return args.take === undefined ? rows : rows.slice(0, args.take);
      },
    },
    event: {
      findMany: async () => [],
      findFirst: async () => ({ seq: 200 }),
    },
    run: {
      findFirst: async () => null,
      findMany: async () => [],
    },
    agentHome: { findUnique: async () => null },
  } as unknown as PrismaClient;

  const deps = {
    prisma,
    env: {
      defaultProvider: "openrouter",
      defaultModel: "model",
      screenProxySecret: "secret",
      sandboxProvider: "docker",
      webOrigin: "https://app.example",
    },
  } as unknown as RouterDeps;

  return {
    router: createRouter(deps),
    messageQueries,
    botUpdates,
    botScopes,
    groupScopes,
  };
}

describe("server history pagination", () => {
  it("bounds the first load and returns older pages in chronological order", async () => {
    const { router, messageQueries } = harness();

    const first = await call(
      router.threads.get,
      { botId: "bot-1", afterSeq: -1 },
      { context: { actor: owner } },
    );
    expect(first.messages).toHaveLength(THREAD_HISTORY_DEFAULT_LIMIT);
    expect(first.messages.map((message) => message.seq)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 70),
    );
    expect(messageQueries[0]).toMatchObject({
      orderBy: { seq: "desc" },
      take: 50,
    });

    const older = await call(
      router.threads.get,
      { botId: "bot-1", beforeSeq: 70, limit: 10 },
      { context: { actor: owner } },
    );
    expect(older.messages.map((message) => message.seq)).toEqual(
      Array.from({ length: 10 }, (_, index) => index + 60),
    );
    expect(messageQueries[1]).toMatchObject({
      where: { threadId: "thread-1", seq: { lt: 70 } },
      orderBy: { seq: "desc" },
      take: 10,
    });

    const group = await call(
      router.botGroups.thread,
      { groupId: "group-1", beforeSeq: 20, limit: 5 },
      { context: { actor: owner } },
    );
    expect(group.messages.map((message) => message.seq)).toEqual([15, 16, 17, 18, 19]);
  });

  it("keeps incremental recovery unbounded instead of advancing past omitted messages", () => {
    expect(historyWindow({ afterSeq: 30, limit: 2 })).toEqual({
      seq: { gt: 30 },
      orderBy: { seq: "asc" },
      reverse: false,
    });
    expect(historyWindow({ afterSeq: -1, unbounded: true })).toEqual({
      orderBy: { seq: "desc" },
      reverse: true,
    });
  });

  it("rejects another account before reading bot or group messages", async () => {
    const { router, messageQueries, botScopes, groupScopes } = harness();

    await expect(
      call(router.threads.get, { botId: "bot-1" }, { context: { actor: outsider } }),
    ).rejects.toThrow();
    await expect(
      call(router.botGroups.thread, { groupId: "group-1" }, { context: { actor: outsider } }),
    ).rejects.toThrow();

    expect(messageQueries).toHaveLength(0);
    expect(botScopes.at(-1)).toMatchObject({
      id: "bot-1",
      workspaceId: outsider.workspaceId,
      userId: outsider.userId,
    });
    expect(groupScopes.at(-1)).toMatchObject({
      id: "group-1",
      workspaceId: outsider.workspaceId,
      userId: outsider.userId,
    });
  });
});

describe("unread flag on read", () => {
  // A tela chama threads/get a cada 4 s. Antes, cada chamada escrevia no bot.
  it("does not write when the thread is already read", async () => {
    const { router, botUpdates } = harness({ unread: false });

    await call(router.threads.get, { botId: "bot-1" }, { context: { actor: owner } });
    await call(router.threads.get, { botId: "bot-1" }, { context: { actor: owner } });

    expect(botUpdates).toEqual([]);
  });

  it("clears the unread mark once, on the read that finds it", async () => {
    const { router, botUpdates } = harness({ unread: true });

    await call(router.threads.get, { botId: "bot-1" }, { context: { actor: owner } });
    expect(botUpdates).toEqual([{ unread: false }]);

    await call(router.threads.get, { botId: "bot-1" }, { context: { actor: owner } });
    expect(botUpdates).toHaveLength(1);
  });
});
