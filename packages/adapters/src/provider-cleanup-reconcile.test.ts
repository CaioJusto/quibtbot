import type { SandboxProvider } from "@quibt/adapter-kit";
import type { PrismaClient } from "@quibt/db";
import { describe, expect, it, vi } from "vitest";
import type { LifecycleIntentRow } from "./lifecycle-cleanup-intent.js";
import {
  cleanupActionFromRow,
  isProviderCleanupIntent,
  reconcilePendingProviderCleanups,
  reconcileProviderCleanupIntent,
} from "./provider-cleanup-reconcile.js";
import { cleanupIntentReason } from "./session-lifecycle.js";

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

function gateComputerMocks(providerRef: string | null = "container-1") {
  let gateToken: string | null = null;
  let computerProviderRef = providerRef;
  return {
    findUnique: vi.fn(async () => ({
      bootClaimToken: gateToken,
      state: "running",
      providerRef: computerProviderRef,
    })),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (where.bootClaimToken === null && data.bootClaimToken) {
          gateToken = String(data.bootClaimToken);
          return { count: 1 };
        }
        if (where.bootClaimToken && gateToken === where.bootClaimToken) {
          if (data.bootClaimedAt) return { count: 1 };
          if (data.bootClaimToken === null) {
            gateToken = null;
            if (data.providerRef !== undefined) {
              computerProviderRef = data.providerRef as string | null;
            }
            return { count: 1 };
          }
        }
        if (where.id) {
          if (data.providerRef !== undefined) {
            computerProviderRef = data.providerRef as string | null;
          }
          if (data.bootClaimToken === null) gateToken = null;
          return { count: 1 };
        }
        return { count: 0 };
      },
    ),
  };
}

function lifecycleRow(overrides: Partial<LifecycleIntentRow> = {}): LifecycleIntentRow {
  return {
    workspaceId: "ws-1",
    botId: "bot-a",
    provider: "box",
    providerRef: "box-a",
    status: "pending",
    reason: cleanupIntentReason("stop:idle"),
    lifecycleAction: "stop:idle",
    lifecycleToken: "suspend-token",
    sessionBotId: "bot-a",
    refSnapshotKind: "box",
    refSnapshotProviderRef: "box-a",
    ...overrides,
  };
}

function makeReconcileHarness(options?: {
  row?: LifecycleIntentRow | null;
  stopFails?: boolean;
  destroyFails?: boolean;
  session?: Record<string, unknown>;
}) {
  const row = options?.row ?? null;
  const session = options?.session ?? {
    botId: "bot-a",
    state: "suspending",
    providerRef: "box-a",
    bootClaimToken: "suspend-token",
    controlHolder: "none",
    controlLeaseId: null,
    controlLeaseExpiresAt: null,
    computerId: "comp-1",
    computer: { kind: "box", id: "comp-1" },
  };
  const stop = vi.fn(async () => {
    if (options?.stopFails) throw new Error("stop failed");
  });
  const destroy = vi.fn(async () => {
    if (options?.destroyFails) throw new Error("destroy failed");
  });
  const destroyBotSession = vi.fn(async (_ref, _ctx, opts?: { preserveComputer?: boolean }) => {
    if (opts?.preserveComputer) return;
    await destroy();
  });
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const prisma = {
    desktopSession: {
      findUnique: vi.fn(async () => session),
      updateMany,
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 1 })),
      count: vi.fn(async () => 0),
    },
    bot: { delete: vi.fn(async () => undefined) },
    run: { count: vi.fn(async () => 0) },
    computer: {
      findUnique: vi.fn(async () => ({ bootClaimToken: null, state: "running" })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      delete: vi.fn(async () => undefined),
    },
    orphanProvision: {
      findUnique: vi.fn(async () => row),
      findFirst: vi.fn(async () => row),
      findMany: vi.fn(async () => (row ? [row] : [])),
      updateMany,
    },
    $transaction: vi.fn(async (cb: (tx: typeof prisma) => Promise<void>) => cb(prisma)),
  } as unknown as PrismaClient;
  const sandbox = { stop, destroy, destroyBotSession } as unknown as SandboxProvider;
  return { prisma, sandbox, stop, destroy, destroyBotSession, updateMany, row };
}

function reconcileInput(
  sessionBotId: string,
  lifecycleAction: "stop:idle" | "destroy:delete" = "stop:idle",
) {
  return { workspaceId: "ws-1", sessionBotId, lifecycleAction };
}

describe("provider cleanup reconcile", () => {
  it("detects cleanup intent rows", () => {
    expect(isProviderCleanupIntent(lifecycleRow())).toBe(true);
    expect(cleanupActionFromRow(lifecycleRow())).toBe("stop:idle");
  });

  it("returns absent when no pending intent exists", async () => {
    const { prisma, sandbox, stop } = makeReconcileHarness({ row: null });
    const outcome = await reconcileProviderCleanupIntent(
      { prisma, sandbox },
      reconcileInput("bot-a", "stop:idle"),
    );
    expect(outcome).toBe("absent");
    expect(stop).not.toHaveBeenCalled();
  });

  it("retries stop intent and resolves on provider success", async () => {
    const { prisma, sandbox, stop } = makeReconcileHarness({ row: lifecycleRow() });
    const outcome = await reconcileProviderCleanupIntent(
      { prisma, sandbox },
      reconcileInput("bot-a", "stop:idle"),
    );
    expect(outcome).toBe("resolved");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("retries destroy intent and resolves on provider success", async () => {
    const home = { resolve: vi.fn(() => "/data/homes/bot-a") };
    const { prisma, sandbox, destroyBotSession } = makeReconcileHarness({
      row: lifecycleRow({
        lifecycleAction: "destroy:delete",
        lifecycleToken: "delete-token",
        reason: cleanupIntentReason("destroy:delete"),
      }),
      session: {
        botId: "bot-a",
        state: "deleting",
        providerRef: "box-a",
        bootClaimToken: "delete-token",
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        computerId: "comp-1",
        computer: { kind: "box", id: "comp-1" },
      },
    });
    const outcome = await reconcileProviderCleanupIntent(
      { prisma, sandbox, home: home as never, dataDir: "./data" },
      reconcileInput("bot-a", "destroy:delete"),
    );
    expect(outcome).toBe("resolved");
    expect(destroyBotSession).toHaveBeenCalledOnce();
  });

  it("retries stop intent when provider stop fails without cancelling", async () => {
    const { prisma, sandbox, stop } = makeReconcileHarness({
      stopFails: true,
      row: lifecycleRow(),
    });
    const outcome = await reconcileProviderCleanupIntent(
      { prisma, sandbox },
      reconcileInput("bot-a", "stop:idle"),
    );
    expect(outcome).toBe("pending");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("keeps intent pending when provider call fails", async () => {
    const home = { resolve: vi.fn(() => "/data/homes/bot-a") };
    const { prisma, sandbox, destroyBotSession } = makeReconcileHarness({
      destroyFails: true,
      row: lifecycleRow({
        lifecycleAction: "destroy:delete",
        lifecycleToken: "delete-token",
        reason: cleanupIntentReason("destroy:delete"),
      }),
      session: {
        botId: "bot-a",
        state: "deleting",
        providerRef: "box-a",
        bootClaimToken: "delete-token",
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        computerId: "comp-1",
        computer: { kind: "box", id: "comp-1" },
      },
    });
    const outcome = await reconcileProviderCleanupIntent(
      { prisma, sandbox, home: home as never },
      reconcileInput("bot-a", "destroy:delete"),
    );
    expect(outcome).toBe("pending");
    expect(destroyBotSession).toHaveBeenCalledOnce();
  });

  it("reconciles a bounded batch of pending intents", async () => {
    const rows = [
      lifecycleRow({
        providerRef: "box-a",
        sessionBotId: "bot-a",
        refSnapshotProviderRef: "box-a",
        lifecycleAction: "destroy:delete",
        lifecycleToken: "delete-a",
        reason: cleanupIntentReason("destroy:delete"),
      }),
      lifecycleRow({
        providerRef: "box-b",
        botId: "bot-b",
        sessionBotId: "bot-b",
        refSnapshotProviderRef: "box-b",
        lifecycleToken: "suspend-b",
      }),
    ];
    const stop = vi.fn(async () => undefined);
    const destroy = vi.fn(async () => undefined);
    const destroyBotSession = vi.fn(async (_ref, _ctx, opts?: { preserveComputer?: boolean }) => {
      if (!opts?.preserveComputer) await destroy();
    });
    const prisma = {
      desktopSession: {
        findUnique: vi.fn(async ({ where }: { where: { botId: string } }) => ({
          botId: where.botId,
          state: where.botId === "bot-a" ? "deleting" : "suspending",
          providerRef: where.botId === "bot-a" ? "box-a" : "box-b",
          bootClaimToken: where.botId === "bot-a" ? "delete-a" : "suspend-b",
          controlHolder: "none",
          controlLeaseId: null,
          controlLeaseExpiresAt: null,
          computerId: "comp-1",
          computer: { kind: "box", id: "comp-1" },
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
        findMany: vi.fn(async () => []),
        deleteMany: vi.fn(async () => ({ count: 1 })),
        count: vi.fn(async () => 0),
      },
      bot: { delete: vi.fn(async () => undefined) },
      run: { count: vi.fn(async () => 0) },
      computer: {
        findUnique: vi.fn(async () => ({ bootClaimToken: null, state: "running" })),
        updateMany: vi.fn(async () => ({ count: 1 })),
        delete: vi.fn(async () => undefined),
      },
      orphanProvision: {
        findFirst: vi.fn(
          async ({
            where,
          }: {
            where: {
              workspaceId: string;
              sessionBotId: string;
              lifecycleAction: string;
            };
          }) =>
            rows.find(
              (r) =>
                r.sessionBotId === where.sessionBotId &&
                r.lifecycleAction === where.lifecycleAction,
            ) ?? null,
        ),
        findMany: vi.fn(async () => rows),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      $transaction: vi.fn(async (cb: (tx: typeof prisma) => Promise<void>) => cb(prisma)),
    } as unknown as PrismaClient;
    const sandbox = { stop, destroy, destroyBotSession } as unknown as SandboxProvider;
    const home = { resolve: vi.fn(() => "/data/homes") };
    const resolved = await reconcilePendingProviderCleanups(
      { prisma, sandbox, home: home as never, dataDir: "./data" },
      { limit: 10 },
    );
    expect(resolved).toBe(2);
    expect(stop).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("shared destroy reconciler preserves container when a sibling is active", async () => {
    const row = lifecycleRow({
      lifecycleAction: "destroy:delete",
      lifecycleToken: "delete-token",
      provider: "docker",
      providerRef: "container-1",
      refSnapshotKind: "docker",
      refSnapshotProviderRef: "container-1",
      reason: cleanupIntentReason("destroy:delete"),
    });
    const session = {
      botId: "bot-a",
      state: "deleting",
      providerRef: "container-1",
      bootClaimToken: "delete-token",
      controlHolder: "none",
      controlLeaseId: null,
      controlLeaseExpiresAt: null,
      computerId: "comp-1",
      computer: { kind: "docker", id: "comp-1", providerRef: "container-1" },
    };
    const destroyBotSession = vi.fn(async () => undefined);
    const home = { resolve: vi.fn(() => "/data/homes/bot-a") };
    const gateComputer = gateComputerMocks();
    const prisma = {
      desktopSession: {
        findUnique: vi.fn(async () => session),
        updateMany: vi.fn(async () => ({ count: 1 })),
        findMany: vi.fn(async () => [
          {
            botId: "bot-b",
            state: "running",
            controlHolder: "none",
            controlLeaseId: null,
            controlLeaseUserId: null,
            controlLeaseExpiresAt: null,
            controlFence: 0,
          },
        ]),
        deleteMany: vi.fn(async () => ({ count: 1 })),
        count: vi.fn(async () => 1),
      },
      run: { count: vi.fn(async () => 0) },
      computer: gateComputer,
      orphanProvision: {
        findUnique: vi.fn(async () => row),
        findFirst: vi.fn(async () => row),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      bot: { delete: vi.fn(async () => undefined) },
      $transaction: vi.fn(async (cb: (tx: typeof prisma) => Promise<void>) => cb(prisma)),
    } as unknown as PrismaClient;
    const outcome = await reconcileProviderCleanupIntent(
      { prisma, sandbox: { destroyBotSession } as never, home: home as never, dataDir: "./data" },
      reconcileInput("bot-a", "destroy:delete"),
    );
    expect(outcome).toBe("resolved");
    expect(destroyBotSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      preserveComputer: true,
    });
  });
});
