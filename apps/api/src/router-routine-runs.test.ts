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
  const createdAt = new Date("2026-08-26T12:00:00.000Z");
  const routineScopes: Array<Record<string, unknown>> = [];
  const runQueries: Array<Record<string, unknown>> = [];
  const routine = {
    id: "routine-1",
    workspaceId: owner.workspaceId,
    userId: owner.userId,
    botId: "bot-1",
    groupId: null,
  };
  const prisma = {
    routine: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        routineScopes.push(args.where);
        return args.where.id === routine.id &&
          args.where.workspaceId === owner.workspaceId &&
          args.where.userId === owner.userId
          ? routine
          : null;
      },
    },
    run: {
      findMany: async (args: Record<string, unknown>) => {
        runQueries.push(args);
        return [
          {
            id: "run-1",
            botId: "bot-1",
            threadId: "thread-1",
            taskId: "task-1",
            status: "completed",
            trigger: "routine",
            modelProvider: null,
            modelId: null,
            error: null,
            startedAt: createdAt,
            completedAt: createdAt,
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
  return { router: createRouter(deps), routineScopes, runQueries };
}

describe("routines.runs", () => {
  it("returns the newest five runs associated with the routine", async () => {
    const { router, runQueries } = harness();
    const rows = await call(
      router.routines.runs,
      { routineId: "routine-1", limit: 5 },
      { context: { actor: owner } },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "run-1",
      trigger: "routine",
      createdAt: "2026-08-26T12:00:00.000Z",
    });
    expect(runQueries[0]).toMatchObject({
      where: { routineId: "routine-1", workspaceId: "ws-1", userId: "user-1" },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
  });

  it("rejects another account before reading any runs", async () => {
    const { router, routineScopes, runQueries } = harness();
    await expect(
      call(
        router.routines.runs,
        { routineId: "routine-1", limit: 5 },
        { context: { actor: outsider } },
      ),
    ).rejects.toThrow();
    expect(runQueries).toHaveLength(0);
    expect(routineScopes.at(-1)).toEqual({
      id: "routine-1",
      workspaceId: outsider.workspaceId,
      userId: outsider.userId,
    });
  });
});
