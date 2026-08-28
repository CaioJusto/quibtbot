import type { SandboxProvider } from "@quibt/adapter-kit";
import type { PrismaClient } from "@quibt/db";
import { describe, expect, it, vi } from "vitest";
import { SupervisorRequestError } from "./docker-sandbox.js";
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

/** Histórico vazio: o expurgo em lotes roda antes da transação final da exclusão. */
function emptyHistoryMocks() {
  return {
    findMany: vi.fn(async () => []),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  };
}

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
  stopError?: unknown;
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
    if (options?.stopError) throw options.stopError;
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
    run: { count: vi.fn(async () => 0), ...emptyHistoryMocks() },
    task: emptyHistoryMocks(),
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

/** Sessão já marcada para exclusão, do jeito que o retry a encontra. */
function deletingSession() {
  return {
    botId: "bot-a",
    state: "deleting",
    providerRef: "box-a",
    bootClaimToken: "delete-token",
    controlHolder: "none",
    controlLeaseId: null,
    controlLeaseExpiresAt: null,
    computerId: "comp-1",
    computer: { kind: "box", id: "comp-1" },
  };
}

/** Intent pendente cuja linha de sessão já saiu; `bot` diz se o bot ainda vive. */
function makeVanishedTargetHarness(options: {
  row: LifecycleIntentRow;
  bot: { id: string } | null;
}) {
  const intent = { status: options.row.status, reason: options.row.reason };
  const destroyBotSession = vi.fn(async () => undefined);
  const prisma = {
    desktopSession: {
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      count: vi.fn(async () => 0),
    },
    bot: {
      findUnique: vi.fn(async () => options.bot),
      delete: vi.fn(async () => undefined),
    },
    run: { count: vi.fn(async () => 0), ...emptyHistoryMocks() },
    task: emptyHistoryMocks(),
    computer: {
      findUnique: vi.fn(async () => ({ bootClaimToken: null, state: "running" })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      delete: vi.fn(async () => undefined),
    },
    orphanProvision: {
      findFirst: vi.fn(async () => ({ ...options.row, status: intent.status })),
      findUnique: vi.fn(async () => ({ ...options.row, status: intent.status })),
      findMany: vi.fn(async () => [{ ...options.row, status: intent.status }]),
      updateMany: vi.fn(async ({ data }: { data: { status: string; reason: string } }) => {
        intent.status = data.status;
        intent.reason = data.reason;
        return { count: 1 };
      }),
    },
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(prisma)),
  } as unknown as PrismaClient;
  return { prisma, destroyBotSession, intent };
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

  it("resolves a Box stop retry when the archived ref is already gone", async () => {
    const { prisma, sandbox, stop } = makeReconcileHarness({
      row: lifecycleRow(),
      stopError: new Error("box api POST /boxes/box-a/stop failed: 404 box not found"),
    });
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
      run: { count: vi.fn(async () => 0), ...emptyHistoryMocks() },
      task: emptyHistoryMocks(),
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

  /**
   * A revisão externa: a exclusão precisa ser RETOMÁVEL. Se o expurgo do histórico cai no
   * meio, a sessão tem de continuar em "deleting" com o mesmo token — senão o próprio
   * reconciliador classifica a intent como "stale", cancela, e o bot fica meio apagado.
   */
  it("resumes a destroy that crashed mid-purge instead of cancelling it as stale", async () => {
    const session = {
      botId: "bot-a",
      state: "deleting",
      providerRef: "box-a",
      bootClaimToken: "delete-token",
      controlHolder: "none",
      controlLeaseId: null,
      controlLeaseExpiresAt: null,
      computerId: "comp-1",
      computer: { kind: "box", id: "comp-1" },
    };
    const removed = { session: false, bot: false };
    const row = lifecycleRow({
      lifecycleAction: "destroy:delete",
      lifecycleToken: "delete-token",
      reason: cleanupIntentReason("destroy:delete"),
    });
    const intent = { status: "pending", reason: row.reason };
    let history = ["run-1", "run-2", "run-3"];
    const failPurge = { now: true };
    const destroyBotSession = vi.fn(async () => undefined);
    const home = { resolve: vi.fn(() => "/data/homes/bot-a") };
    const prisma = {
      desktopSession: {
        findUnique: vi.fn(async () => (removed.session ? null : session)),
        updateMany: vi.fn(async () => ({ count: 1 })),
        findMany: vi.fn(async () => []),
        deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          if (removed.session) return { count: 0 };
          if (where.state !== session.state || where.bootClaimToken !== session.bootClaimToken) {
            return { count: 0 };
          }
          removed.session = true;
          return { count: 1 };
        }),
        count: vi.fn(async () => 0),
      },
      run: {
        count: vi.fn(async () => 0),
        findMany: vi.fn(async () => history.map((id) => ({ id }))),
        deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
          if (failPurge.now) throw new Error("connection lost mid-purge");
          const ids = where.id.in;
          history = history.filter((id) => !ids.includes(id));
          return { count: ids.length };
        }),
      },
      task: emptyHistoryMocks(),
      bot: {
        delete: vi.fn(async () => {
          removed.bot = true;
          return undefined;
        }),
      },
      computer: {
        findUnique: vi.fn(async () => ({ bootClaimToken: null, state: "running" })),
        updateMany: vi.fn(async () => ({ count: 1 })),
        delete: vi.fn(async () => undefined),
      },
      orphanProvision: {
        findFirst: vi.fn(async () => ({ ...row, status: intent.status })),
        findUnique: vi.fn(async () => ({ ...row, status: intent.status })),
        updateMany: vi.fn(async ({ data }: { data: { status: string; reason: string } }) => {
          intent.status = data.status;
          intent.reason = data.reason;
          return { count: 1 };
        }),
      },
      $transaction: vi.fn(async (cb: (tx: typeof prisma) => Promise<unknown>) => cb(prisma)),
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      sandbox: { destroyBotSession } as never,
      home: home as never,
      dataDir: "./data",
    };

    const first = await reconcileProviderCleanupIntent(
      deps,
      reconcileInput("bot-a", "destroy:delete"),
    );
    expect(first).toBe("pending");
    expect(intent.status).toBe("pending");
    expect(session.state).toBe("deleting");
    expect(session.bootClaimToken).toBe("delete-token");
    expect(removed.bot).toBe(false);

    failPurge.now = false;
    const second = await reconcileProviderCleanupIntent(
      deps,
      reconcileInput("bot-a", "destroy:delete"),
    );
    expect(second).toBe("resolved");
    expect(intent.status).toBe("resolved");
    expect(history).toEqual([]);
    expect(removed.session).toBe(true);
    expect(removed.bot).toBe(true);
    expect(destroyBotSession).toHaveBeenCalledTimes(2);
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
      run: { count: vi.fn(async () => 0), ...emptyHistoryMocks() },
      task: emptyHistoryMocks(),
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

  /**
   * Retomada de verdade: o retry re-chama o destroy sobre o ref que a passada anterior já
   * apagou. Um 404 do provedor é o fim que a exclusão pede — se subisse como erro, a intent
   * ficaria pendente para sempre e o bot, meio apagado.
   */
  it("resolves the retry when the provider says the ref is already gone", async () => {
    const home = { resolve: vi.fn(() => "/data/homes/bot-a") };
    const destroyBotSession = vi.fn(async () => {
      throw new SupervisorRequestError("destroy", 404);
    });
    const { prisma, sandbox } = makeReconcileHarness({
      row: lifecycleRow({
        lifecycleAction: "destroy:delete",
        lifecycleToken: "delete-token",
        reason: cleanupIntentReason("destroy:delete"),
      }),
      session: deletingSession(),
    });
    const outcome = await reconcileProviderCleanupIntent(
      {
        prisma,
        sandbox: { ...sandbox, destroyBotSession } as never,
        home: home as never,
        dataDir: "./data",
      },
      reconcileInput("bot-a", "destroy:delete"),
    );
    expect(outcome).toBe("resolved");
    expect(destroyBotSession).toHaveBeenCalledOnce();
  });

  it("keeps the intent pending when the provider fails for real", async () => {
    const home = { resolve: vi.fn(() => "/data/homes/bot-a") };
    const destroyBotSession = vi.fn(async () => {
      throw new SupervisorRequestError("destroy", 503, JSON.stringify({ code: "docker-down" }));
    });
    const { prisma, sandbox, updateMany } = makeReconcileHarness({
      row: lifecycleRow({
        lifecycleAction: "destroy:delete",
        lifecycleToken: "delete-token",
        reason: cleanupIntentReason("destroy:delete"),
      }),
      session: deletingSession(),
    });
    const outcome = await reconcileProviderCleanupIntent(
      {
        prisma,
        sandbox: { ...sandbox, destroyBotSession } as never,
        home: home as never,
        dataDir: "./data",
      },
      reconcileInput("bot-a", "destroy:delete"),
    );
    expect(outcome).toBe("pending");
    expect(updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "resolved" }) }),
    );
  });

  /**
   * O processo morre ENTRE a transação final e `resolveLifecycleCleanupIntent`: a sessão e
   * o bot já saíram, então a validação passa a devolver "missing" e a intent ficava pendente
   * para sempre, retentada a cada 5 minutos. Alvo que não existe mais = trabalho terminado.
   */
  it("resolves a pending intent whose target vanished after the closing transaction", async () => {
    const row = lifecycleRow({
      lifecycleAction: "destroy:delete",
      lifecycleToken: "delete-token",
      reason: cleanupIntentReason("destroy:delete"),
    });
    const { prisma, destroyBotSession, intent } = makeVanishedTargetHarness({ row, bot: null });
    const outcome = await reconcileProviderCleanupIntent(
      { prisma, sandbox: { destroyBotSession } as never, home: {} as never, dataDir: "./data" },
      reconcileInput("bot-a", "destroy:delete"),
    );
    expect(outcome).toBe("resolved");
    expect(intent.status).toBe("resolved");
    // Nada de re-chamar o provedor: sem a linha da sessão não dá para saber se o ref é
    // compartilhado, e destruir o container de um bot vivo seria pior que a intent presa.
    expect(destroyBotSession).not.toHaveBeenCalled();
  });

  it("resolves a vanished stop intent the same way", async () => {
    const { prisma, intent } = makeVanishedTargetHarness({ row: lifecycleRow(), bot: null });
    const outcome = await reconcileProviderCleanupIntent(
      { prisma, sandbox: { stop: vi.fn(async () => undefined) } as never },
      reconcileInput("bot-a", "stop:idle"),
    );
    expect(outcome).toBe("resolved");
    expect(intent.status).toBe("resolved");
  });

  it("never resolves an intent while the bot is still alive", async () => {
    const row = lifecycleRow({
      lifecycleAction: "destroy:delete",
      lifecycleToken: "delete-token",
      reason: cleanupIntentReason("destroy:delete"),
    });
    const { prisma, intent } = makeVanishedTargetHarness({ row, bot: { id: "bot-a" } });
    const outcome = await reconcileProviderCleanupIntent(
      { prisma, sandbox: { destroyBotSession: vi.fn() } as never, home: {} as never },
      reconcileInput("bot-a", "destroy:delete"),
    );
    expect(outcome).toBe("pending");
    expect(intent.status).toBe("pending");
  });

  it("leaves a malformed intent pending: that target never existed", async () => {
    const row = lifecycleRow({
      lifecycleAction: "destroy:delete",
      lifecycleToken: null,
      reason: cleanupIntentReason("destroy:delete"),
    });
    const { prisma, intent } = makeVanishedTargetHarness({ row, bot: null });
    const outcome = await reconcileProviderCleanupIntent(
      { prisma, sandbox: { destroyBotSession: vi.fn() } as never, home: {} as never },
      reconcileInput("bot-a", "destroy:delete"),
    );
    expect(outcome).toBe("pending");
    expect(intent.status).toBe("pending");
  });
});
