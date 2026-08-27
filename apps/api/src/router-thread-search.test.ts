import { call } from "@orpc/server";
import type { Actor } from "@quibt/contracts";
import type { PrismaClient } from "@quibt/db";
import { describe, expect, it } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

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

function harness() {
  const botScopes: Array<Record<string, unknown>> = [];
  const groupScopes: Array<Record<string, unknown>> = [];
  const messageQueries: Array<Record<string, unknown>> = [];
  const createdAt = new Date("2026-08-27T09:00:00.000Z");
  const prisma = {
    bot: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        botScopes.push(args.where);
        return args.where.userId === owner.userId
          ? [{ id: "bot-1", name: "Pesquisa", thread: { id: "thread-owner" } }]
          : [];
      },
    },
    botGroup: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        groupScopes.push(args.where);
        return args.where.userId === owner.userId
          ? [{ id: "group-1", name: "Equipe", thread: { id: "thread-group" } }]
          : [];
      },
    },
    message: {
      findMany: async (args: Record<string, unknown>) => {
        messageQueries.push(args);
        return [
          {
            id: "message-1",
            threadId: "thread-owner",
            seq: 7,
            blocks: [{ kind: "text", text: "Reunião sobre orçamento" }],
            createdAt,
          },
        ];
      },
    },
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
    botScopes,
    groupScopes,
    messageQueries,
  };
}

describe("threads.search", () => {
  it("searches only thread ids owned by the authenticated account", async () => {
    const { router, botScopes, groupScopes, messageQueries } = harness();
    const rows = await call(
      router.threads.search,
      { query: "reuniao orcamento", limit: 8 },
      { context: { actor: owner } },
    );

    expect(rows).toEqual([
      {
        messageId: "message-1",
        threadId: "thread-owner",
        seq: 7,
        botId: "bot-1",
        groupId: null,
        ownerName: "Pesquisa",
        text: "Reunião sobre orçamento",
        createdAt: "2026-08-27T09:00:00.000Z",
      },
    ]);
    expect(messageQueries[0]).toMatchObject({
      where: { threadId: { in: ["thread-owner", "thread-group"] } },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    expect(botScopes[0]).toEqual({ workspaceId: owner.workspaceId, userId: owner.userId });
    expect(groupScopes[0]).toEqual({ workspaceId: owner.workspaceId, userId: owner.userId });
  });

  it("does not read messages when another account has no owned threads", async () => {
    const { router, botScopes, groupScopes, messageQueries } = harness();
    await expect(
      call(router.threads.search, { query: "reuniao" }, { context: { actor: outsider } }),
    ).resolves.toEqual([]);

    expect(messageQueries).toHaveLength(0);
    expect(botScopes[0]).toEqual({ workspaceId: outsider.workspaceId, userId: outsider.userId });
    expect(groupScopes[0]).toEqual({
      workspaceId: outsider.workspaceId,
      userId: outsider.userId,
    });
  });
});
