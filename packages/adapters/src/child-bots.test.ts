import type { AdapterContext, SandboxProvider } from "@quibt/adapter-kit";
import type { PrismaClient } from "@quibt/db";
import { describe, expect, it, vi } from "vitest";
import { confirmSpawnedBotName, destroyBot, spawnBot } from "./child-bots.js";

vi.mock("node:fs/promises", () => ({
  rm: vi.fn(async () => undefined),
}));

vi.mock("@quibt/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@quibt/db")>();
  return {
    ...actual,
    closeComputerUsage: vi.fn(async () => undefined),
  };
});

type ProviderKind = "docker" | "remote-supervisor" | "e2b" | "box";

const providerFixtures: Record<
  ProviderKind,
  { kind: ProviderKind; sessionRef: string; computerRef: string }
> = {
  docker: {
    kind: "docker",
    sessionRef: "container-workspace",
    computerRef: "container-workspace",
  },
  "remote-supervisor": {
    kind: "remote-supervisor",
    sessionRef: "remote-workspace",
    computerRef: "remote-workspace",
  },
  e2b: {
    kind: "e2b",
    sessionRef: "e2b-bot-a",
    computerRef: "legacy-e2b-shared",
  },
  box: {
    kind: "box",
    sessionRef: "box-a",
    computerRef: "legacy-shared-box",
  },
};

function deleteContext(botId = "bot-a"): AdapterContext {
  return {
    operationId: "delete-bot",
    traceId: "delete-bot",
    workspaceId: "ws-1",
    userId: "user-1",
    botId,
    signal: new AbortController().signal,
  };
}

function makeDeleteHarness(
  kind: ProviderKind,
  options?: { siblingRunning?: boolean; claimFails?: boolean },
) {
  const fixture = providerFixtures[kind];
  const desktop = {
    botId: "bot-a",
    workspaceId: "ws-1",
    computerId: "computer-1",
    display: 10,
    providerRef: fixture.sessionRef,
    screenUrl: "https://screen-a",
    state: "running",
    controlHolder: "none",
    bootClaimToken: null as string | null,
    bootClaimedAt: null as Date | null,
    computer: {
      id: "computer-1",
      kind: fixture.kind,
      providerRef: fixture.computerRef,
      state: "running",
      bootClaimToken: null as string | null,
    },
  };
  const siblingDesktop = {
    botId: "bot-b",
    workspaceId: "ws-1",
    computerId: "computer-1",
    display: 11,
    providerRef: kind === "box" ? "box-b" : kind === "e2b" ? "e2b-bot-b" : fixture.sessionRef,
    screenUrl: "https://screen-b",
    state: options?.siblingRunning ? "running" : "stopped",
    controlHolder: "none",
    computer: desktop.computer,
  };
  const sessions = [desktop, siblingDesktop];
  const destroy = vi.fn(async (_ref?: unknown, _ctx?: unknown) => undefined);
  const stop = vi.fn(async (_ref?: unknown, _ctx?: unknown) => undefined);
  const destroyBotSession = vi.fn(
    async (ref: unknown, ctx: unknown, options?: { preserveComputer?: boolean }) => {
      if (options?.preserveComputer) {
        await stop(ref, ctx);
        return;
      }
      await destroy(ref, ctx);
    },
  );
  const sandbox = { destroy, stop, destroyBotSession } as unknown as SandboxProvider;
  const orphanCreate = vi.fn(async () => undefined);
  const orphanFindFirst = vi.fn(async () => null);
  const orphanUpdate = vi.fn(async () => undefined);
  const prisma = {
    bot: {
      findUnique: vi.fn(async () => ({
        id: "bot-a",
        workspaceId: "ws-1",
        desktopSession: desktop,
      })),
      delete: vi.fn(async () => undefined),
    },
    run: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      count: vi.fn(async () => 0),
    },
    desktopSession: {
      findUnique: vi.fn(async ({ where }: { where: { botId?: string } }) => {
        if (where.botId === "bot-a") return desktop;
        return null;
      }),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            computerId?: string;
            botId?: { not?: string };
            state?: { in?: string[] };
          };
        }) => {
          if (where.computerId !== "computer-1" || where.botId?.not !== "bot-a") return [];
          return sessions
            .filter((s) => s.botId !== "bot-a")
            .filter((s) => !where.state?.in || where.state.in.includes(s.state))
            .map((s) => ({
              botId: s.botId,
              state: s.state,
              controlHolder: s.controlHolder,
              controlLeaseId: null,
              controlLeaseUserId: null,
              controlLeaseExpiresAt: null,
              controlFence: 0,
            }));
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          if (where.botId !== "bot-a") return { count: 0 };
          const holder = where.controlHolder as { not?: string } | undefined;
          if (holder?.not === "user" && desktop.controlHolder === "user") return { count: 0 };
          if (where.state === "suspending" && desktop.state !== "suspending") return { count: 0 };
          if (where.state === "deleting" && desktop.state !== "deleting") return { count: 0 };
          if (
            where.state &&
            typeof where.state === "object" &&
            "in" in where.state &&
            Array.isArray(where.state.in) &&
            !where.state.in.includes(desktop.state)
          ) {
            return { count: 0 };
          }
          if (where.bootClaimToken === null && desktop.bootClaimToken !== null) return { count: 0 };
          if (
            typeof where.bootClaimToken === "string" &&
            desktop.bootClaimToken !== where.bootClaimToken
          ) {
            return { count: 0 };
          }
          if (options?.claimFails && where.bootClaimToken === null) return { count: 0 };
          Object.assign(desktop, data);
          return { count: 1 };
        },
      ),
      deleteMany: vi.fn(async () => ({ count: 1 })),
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.computerId === "computer-1") {
          return sessions.filter((s) => s.botId !== "bot-a").length;
        }
        return 0;
      }),
    },
    computer: {
      findUnique: vi.fn(async () => desktop.computer),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(desktop.computer, data);
        return { count: 1 };
      }),
      delete: vi.fn(async () => undefined),
    },
    orphanProvision: {
      findFirst: orphanFindFirst,
      create: orphanCreate,
      update: orphanUpdate,
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $transaction: vi.fn(async (cb: (tx: typeof prisma) => Promise<void>) => cb(prisma)),
  } as unknown as PrismaClient;
  const home = { resolve: vi.fn(() => "/data/homes/bot-a") } as never;
  return {
    prisma,
    sandbox,
    destroy,
    stop,
    destroyBotSession,
    orphanCreate,
    desktop,
    siblingDesktop,
    fixture,
    home,
  };
}

describe("spawned bot creation", () => {
  it("returns the existing child when a spawn is retried", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: "child-1",
      name: "Scout",
      title: "Venue researcher",
      thread: { id: "thread-1" },
    });
    const enqueue = vi.fn();

    const result = await spawnBot(
      {
        prisma: { bot: { findFirst } } as unknown as PrismaClient,
        wakeup: { enqueue },
      },
      {
        spawnedBy: {
          id: "parent-1",
          name: "Chief",
          workspaceId: "workspace-1",
          userId: "user-1",
        },
        runId: "run-retry",
        name: " Scout ",
        title: "Ignored on a retry",
        prompt: "Do not enqueue this twice",
      },
    );

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        userId: "user-1",
        parentBotId: "parent-1",
        name: "Scout",
      },
      include: { thread: true },
      orderBy: { createdAt: "asc" },
    });
    expect(result).toEqual({
      ok: true,
      duplicate: true,
      botId: "child-1",
      name: "Scout",
      title: "Venue researcher",
      threadId: "thread-1",
    });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("spawned bot deletion", () => {
  it("refuses when confirm_name does not match exactly", () => {
    expect(confirmSpawnedBotName("scout", "Scout")).toMatchObject({ ok: false });
    expect(confirmSpawnedBotName("Scout ", "Scout")).toMatchObject({ ok: false });
  });

  it("accepts an exact name match", () => {
    expect(confirmSpawnedBotName("Scout", "Scout")).toEqual({ ok: true });
  });
});

describe("destroyBot provider isolation", () => {
  it.each(["box", "e2b"] as const)(
    "deleting %s bot A destroys only the session ref while bot B stays untouched",
    async (kind) => {
      const { prisma, sandbox, destroy, siblingDesktop, fixture, home } = makeDeleteHarness(kind, {
        siblingRunning: true,
      });
      await destroyBot({ prisma, sandbox, home }, "bot-a", deleteContext());
      expect(destroy).toHaveBeenCalledWith(
        expect.objectContaining({
          providerRef: fixture.sessionRef,
          botId: "bot-a",
        }),
        expect.anything(),
      );
      expect(siblingDesktop.providerRef).toBe(kind === "box" ? "box-b" : "e2b-bot-b");
      expect(prisma.desktopSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ botId: "bot-a", bootClaimToken: null }),
          data: expect.objectContaining({ state: "deleting" }),
        }),
      );
    },
  );

  it.each(["docker", "remote-supervisor"] as const)(
    "deleting %s bot A preserves the shared container when bot B keeps running",
    async (kind) => {
      const { prisma, sandbox, destroyBotSession, fixture, home } = makeDeleteHarness(kind, {
        siblingRunning: true,
      });
      await destroyBot({ prisma, sandbox, home }, "bot-a", deleteContext());
      expect(destroyBotSession).toHaveBeenCalledWith(
        expect.objectContaining({
          providerRef: fixture.computerRef,
          botId: "bot-a",
        }),
        expect.anything(),
        { preserveComputer: true },
      );
      expect(prisma.computer.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ providerRef: null }),
        }),
      );
    },
  );

  it.each(["docker", "remote-supervisor"] as const)(
    "deleting %s bot A may destroy the shared container when no siblings remain",
    async (kind) => {
      const { prisma, sandbox, destroyBotSession, fixture, home } = makeDeleteHarness(kind, {
        siblingRunning: false,
      });
      await destroyBot({ prisma, sandbox, home }, "bot-a", deleteContext());
      expect(destroyBotSession).toHaveBeenCalledWith(
        expect.objectContaining({
          providerRef: fixture.computerRef,
          botId: "bot-a",
        }),
        expect.anything(),
        { preserveComputer: false },
      );
      expect(prisma.computer.updateMany).toHaveBeenCalled();
    },
  );

  it("records cleanup intent before destroy and resolves on success", async () => {
    const { prisma, sandbox, destroy, orphanCreate, home } = makeDeleteHarness("box");
    await destroyBot({ prisma, sandbox, home }, "bot-a", deleteContext());
    expect(orphanCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "pending",
          lifecycleAction: "destroy:delete",
          lifecycleToken: expect.any(String),
          sessionBotId: "bot-a",
        }),
      }),
    );
    expect(prisma.orphanProvision.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "resolved" }),
      }),
    );
    expect(destroy).toHaveBeenCalled();
  });

  it("keeps providerRef until destroy completes", async () => {
    const { prisma, sandbox, destroy, desktop, home } = makeDeleteHarness("box");
    destroy.mockImplementationOnce(async () => {
      expect(desktop.providerRef).toBe("box-a");
    });
    await destroyBot({ prisma, sandbox, home }, "bot-a", deleteContext());
    expect(desktop.providerRef).toBeNull();
  });

  it("keeps lifecycle destroy intent pending when provider destroy fails", async () => {
    const { prisma, sandbox, destroy, orphanCreate, desktop, home } = makeDeleteHarness("box");
    destroy.mockRejectedValueOnce(new Error("provider unavailable"));
    await destroyBot({ prisma, sandbox, home }, "bot-a", deleteContext());
    expect(orphanCreate).toHaveBeenCalledTimes(1);
    expect(orphanCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "pending",
          lifecycleAction: "destroy:delete",
          lifecycleToken: expect.any(String),
          sessionBotId: "bot-a",
          refSnapshotProviderRef: "box-a",
        }),
      }),
    );
    expect(desktop.state).toBe("deleting");
    expect(prisma.bot.delete).not.toHaveBeenCalled();
  });

  it("does not destroy when delete CAS claim fails", async () => {
    const { prisma, sandbox, destroy, home } = makeDeleteHarness("box", { claimFails: true });
    await destroyBot({ prisma, sandbox, home }, "bot-a", deleteContext());
    expect(destroy).not.toHaveBeenCalled();
  });

  it("does not destroy when the target session reactivated into booting", async () => {
    const { prisma, sandbox, destroy, desktop, home } = makeDeleteHarness("box");
    let validated = false;
    vi.mocked(prisma.desktopSession.findUnique).mockImplementation((async () => {
      if (!validated && desktop.state === "deleting") {
        validated = true;
        desktop.state = "booting";
        desktop.bootClaimToken = "boot-winner";
      }
      return desktop;
    }) as never);
    await destroyBot({ prisma, sandbox, home }, "bot-a", deleteContext());
    expect(destroy).not.toHaveBeenCalled();
  });

  it("never destroys a per-bot sandbox using the legacy computer ref", async () => {
    const { prisma, sandbox, destroy, desktop, home } = makeDeleteHarness("box");
    desktop.providerRef = null as never;
    await destroyBot({ prisma, sandbox, home }, "bot-a", deleteContext());
    expect(destroy).not.toHaveBeenCalled();
  });

  it("clears shared computer providerRef when no active siblings remain after destroy", async () => {
    const { prisma, sandbox, destroy, desktop, home } = makeDeleteHarness("docker", {
      siblingRunning: false,
    });
    desktop.computer.providerRef = "container-workspace";
    desktop.computer.state = "running";
    await destroyBot({ prisma, sandbox, home }, "bot-a", deleteContext());
    expect(destroy).toHaveBeenCalled();
    expect(desktop.computer.providerRef).toBeNull();
    expect(desktop.computer.state).toBe("stopped");
  });

  it("preserves shared computer providerRef when an active sibling remains", async () => {
    const { prisma, sandbox, destroyBotSession, desktop, home } = makeDeleteHarness("docker", {
      siblingRunning: true,
    });
    desktop.computer.providerRef = "container-workspace";
    await destroyBot({ prisma, sandbox, home }, "bot-a", deleteContext());
    expect(destroyBotSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      preserveComputer: true,
    });
    expect(desktop.computer.providerRef).toBe("container-workspace");
  });

  it("acquires session-start gate for shared destroy", async () => {
    const { prisma, sandbox, home } = makeDeleteHarness("docker");
    await destroyBot({ prisma, sandbox, home }, "bot-a", deleteContext());
    expect(prisma.computer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ bootClaimToken: null }),
        data: expect.objectContaining({ bootClaimToken: expect.any(String) }),
      }),
    );
  });

  it("releases deleting claim when shared session gate acquisition fails", async () => {
    const { prisma, sandbox, desktop, orphanCreate, home } = makeDeleteHarness("docker");
    vi.mocked(prisma.computer.updateMany).mockResolvedValue({ count: 0 });
    await destroyBot({ prisma, sandbox, home }, "bot-a", deleteContext());
    expect(desktop.state).toBe("running");
    expect(desktop.bootClaimToken).toBeNull();
    expect(orphanCreate).not.toHaveBeenCalled();
  });
});
