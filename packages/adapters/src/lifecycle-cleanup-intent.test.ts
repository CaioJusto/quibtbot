import type { SandboxProvider } from "@quibt/adapter-kit";
import type { PrismaClient } from "@quibt/db";
import { describe, expect, it, vi } from "vitest";
import * as botDestroyFinalize from "./bot-destroy-finalize.js";
import {
  cancelLifecycleCleanupIntent,
  isBootOrphanRefActive,
  isBootOrphanRow,
  type LifecycleIntentRow,
  recordLifecycleCleanupIntent,
  resolveLifecycleCleanupIntent,
  validateLifecycleCleanupIntent,
} from "./lifecycle-cleanup-intent.js";
import {
  cleanupActionFromRow,
  isProviderCleanupIntent,
  reconcileProviderCleanupIntent,
} from "./provider-cleanup-reconcile.js";
import { cleanupIntentReason } from "./session-lifecycle.js";

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

describe("lifecycle cleanup intent validation", () => {
  it("cancels reconciler when session reactivated to running", async () => {
    const session = {
      botId: "bot-a",
      state: "running",
      providerRef: "box-a",
      bootClaimToken: null,
      controlHolder: "none",
      controlLeaseId: null,
      controlLeaseExpiresAt: null,
      computerId: "comp-1",
      computer: { kind: "box", id: "comp-1" },
    };
    const prisma = {
      desktopSession: {
        findUnique: vi.fn(async () => session),
      },
      orphanProvision: {
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    } as unknown as PrismaClient;

    const validation = await validateLifecycleCleanupIntent(prisma, lifecycleRow());
    expect(validation).toEqual({ ok: false, reason: "reactivated" });

    const stop = vi.fn();
    const outcome = await reconcileProviderCleanupIntent(
      {
        prisma: {
          ...prisma,
          orphanProvision: {
            ...prisma.orphanProvision,
            findFirst: vi.fn(async () => lifecycleRow()),
          },
        } as never,
        sandbox: { stop } as never,
      },
      { workspaceId: "ws-1", sessionBotId: "bot-a", lifecycleAction: "stop:idle" },
    );
    expect(outcome).toBe("cancelled");
    expect(stop).not.toHaveBeenCalled();
  });

  it("creates lifecycle intent row on first record", async () => {
    const create = vi.fn(async () => undefined);
    const findFirst = vi.fn(async () => null);
    const prisma = {
      orphanProvision: { findFirst, create, update: vi.fn() },
      $transaction: vi.fn(async (cb: (tx: typeof prisma) => Promise<void>) => cb(prisma)),
    } as unknown as PrismaClient;
    await recordLifecycleCleanupIntent(prisma, {
      ref: { id: "box-a", botId: "bot-a", kind: "box", providerRef: "box-a" },
      action: "destroy:delete",
      lifecycleToken: "delete-token",
      sessionBotId: "bot-a",
      workspaceId: "ws-1",
      reason: cleanupIntentReason("destroy:delete"),
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: "ws-1",
        sessionBotId: "bot-a",
        lifecycleAction: "destroy:delete",
      },
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lifecycleAction: "destroy:delete",
          lifecycleToken: "delete-token",
          sessionBotId: "bot-a",
          refSnapshotProviderRef: "box-a",
        }),
      }),
    );
  });

  it("updates existing lifecycle intent for same bot and action without creating duplicate", async () => {
    const existing = {
      id: "intent-1",
      workspaceId: "ws-1",
      sessionBotId: "bot-a",
      lifecycleAction: "destroy:delete",
      lifecycleToken: "old-token",
    };
    const create = vi.fn(async () => undefined);
    const update = vi.fn(async () => undefined);
    const findFirst = vi.fn(async () => existing);
    const prisma = {
      orphanProvision: { findFirst, create, update },
      $transaction: vi.fn(async (cb: (tx: typeof prisma) => Promise<void>) => cb(prisma)),
    } as unknown as PrismaClient;

    await recordLifecycleCleanupIntent(prisma, {
      ref: { id: "box-a", botId: "bot-a", kind: "box", providerRef: "box-a" },
      action: "destroy:delete",
      lifecycleToken: "new-token",
      sessionBotId: "bot-a",
      workspaceId: "ws-1",
      reason: cleanupIntentReason("destroy:delete"),
    });

    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "intent-1" },
      data: expect.objectContaining({
        lifecycleToken: "new-token",
        refSnapshotProviderRef: "box-a",
        status: "pending",
      }),
    });
  });

  it("boot orphan destroy only when ref is not active", async () => {
    const prisma = {
      computer: {
        findUnique: vi.fn(async () => ({
          providerRef: "orphan-ref",
          state: "running",
          kind: "docker",
        })),
      },
      desktopSession: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    expect(
      await isBootOrphanRefActive(prisma, {
        workspaceId: "ws-1",
        kind: "docker",
        providerRef: "orphan-ref",
      }),
    ).toBe(true);
  });

  it("classifies any pending intent without lifecycleAction as boot orphan regardless of reason", () => {
    expect(
      isBootOrphanRow({
        workspaceId: "ws-1",
        botId: null,
        provider: "docker",
        providerRef: "orphan-ref",
        status: "pending",
        reason: "arbitrary operator note",
        lifecycleAction: null,
        lifecycleToken: null,
        sessionBotId: null,
        refSnapshotKind: null,
        refSnapshotProviderRef: null,
      }),
    ).toBe(true);
    expect(
      isBootOrphanRow({
        ...lifecycleRow(),
        lifecycleAction: "stop:idle",
      }),
    ).toBe(false);
  });

  it("treats reused orphan rows as boot orphans after lifecycle fields are cleared", () => {
    expect(
      isBootOrphanRow({
        workspaceId: "ws-1",
        botId: "bot-a",
        provider: "docker",
        providerRef: "container-1",
        status: "pending",
        reason: "boot orphan retry",
        lifecycleAction: null,
        lifecycleToken: null,
        sessionBotId: null,
        refSnapshotKind: null,
        refSnapshotProviderRef: null,
      }),
    ).toBe(true);
    expect(
      isBootOrphanRow({
        workspaceId: "ws-1",
        botId: "bot-a",
        provider: "docker",
        providerRef: "container-1",
        status: "pending",
        reason: "boot orphan retry",
        lifecycleAction: "destroy:delete",
        lifecycleToken: "stale",
        sessionBotId: "bot-a",
        refSnapshotKind: "docker",
        refSnapshotProviderRef: "container-1",
      }),
    ).toBe(false);
  });
});

describe("provider cleanup reconcile risks", () => {
  it("finalizes stop after provider success when session still suspending", async () => {
    const session = {
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
    const stop = vi.fn(async () => undefined);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      desktopSession: {
        findUnique: vi.fn(async () => session),
        updateMany,
        findMany: vi.fn(async () => []),
      },
      run: { count: vi.fn(async () => 0) },
      orphanProvision: {
        findFirst: vi.fn(async () => lifecycleRow()),
        updateMany,
      },
    } as unknown as PrismaClient;
    const outcome = await reconcileProviderCleanupIntent(
      { prisma, sandbox: { stop } as unknown as SandboxProvider },
      { workspaceId: "ws-1", sessionBotId: "bot-a", lifecycleAction: "stop:idle" },
    );
    expect(outcome).toBe("resolved");
    expect(stop).toHaveBeenCalledOnce();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          botId: "bot-a",
          state: "suspending",
          bootClaimToken: "suspend-token",
        }),
        data: expect.objectContaining({ state: "suspended" }),
      }),
    );
  });

  it("crash after provider before finalize retries finalize without requiring duplicate semantics failure", async () => {
    const session = {
      botId: "bot-a",
      state: "deleting",
      providerRef: "box-a",
      bootClaimToken: "delete-token",
      computer: { id: "comp-1", kind: "box" },
      computerId: "comp-1",
      controlHolder: "none",
      controlLeaseId: null,
      controlLeaseExpiresAt: null,
    };
    const destroy = vi.fn(async () => undefined);
    const home = { resolve: vi.fn(() => "/data/homes/bot-a") };
    const finalizeSpy = vi
      .spyOn(botDestroyFinalize, "finalizeBotDestroyAfterProvider")
      .mockResolvedValue(true);
    const prisma = {
      desktopSession: {
        findUnique: vi.fn(async () => session),
        updateMany: vi.fn(async () => ({ count: 1 })),
        findMany: vi.fn(async () => []),
      },
      run: { count: vi.fn(async () => 0) },
      orphanProvision: {
        findFirst: vi.fn(async () =>
          lifecycleRow({
            lifecycleAction: "destroy:delete",
            lifecycleToken: "delete-token",
            refSnapshotProviderRef: "box-a",
            reason: cleanupIntentReason("destroy:delete"),
          }),
        ),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    } as unknown as PrismaClient;

    const outcome = await reconcileProviderCleanupIntent(
      { prisma, sandbox: { destroy } as never, home: home as never },
      { workspaceId: "ws-1", sessionBotId: "bot-a", lifecycleAction: "stop:idle" },
    );
    expect(outcome).toBe("resolved");
    expect(destroy).toHaveBeenCalledOnce();
    expect(finalizeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ home: home }),
      expect.objectContaining({ botId: "bot-a", claimToken: "delete-token" }),
    );
    finalizeSpy.mockRestore();
  });

  it("retries destroy after provider failure when lifecycle intent fields remain intact", async () => {
    const row = lifecycleRow({
      lifecycleAction: "destroy:delete",
      lifecycleToken: "delete-token",
      refSnapshotProviderRef: "box-a",
      reason: cleanupIntentReason("destroy:delete"),
    });
    expect(isBootOrphanRow(row)).toBe(false);

    const session = {
      botId: "bot-a",
      state: "deleting",
      providerRef: "box-a",
      bootClaimToken: "delete-token",
      computer: { id: "comp-1", kind: "box" },
      computerId: "comp-1",
      controlHolder: "none",
      controlLeaseId: null,
      controlLeaseExpiresAt: null,
    };
    const destroy = vi.fn(async () => undefined);
    const home = { resolve: vi.fn(() => "/data/homes/bot-a") };
    const finalizeSpy = vi
      .spyOn(botDestroyFinalize, "finalizeBotDestroyAfterProvider")
      .mockResolvedValue(true);
    const cancelSpy = vi.fn(async () => ({ count: 0 }));
    const prisma = {
      desktopSession: {
        findUnique: vi.fn(async () => session),
        updateMany: vi.fn(async () => ({ count: 1 })),
        findMany: vi.fn(async () => []),
        deleteMany: vi.fn(async () => ({ count: 1 })),
        count: vi.fn(async () => 0),
      },
      run: { count: vi.fn(async () => 0) },
      bot: { delete: vi.fn(async () => undefined) },
      computer: {
        findUnique: vi.fn(async () => ({ bootClaimToken: null, state: "running" })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      orphanProvision: {
        findFirst: vi.fn(async () => row),
        updateMany: cancelSpy,
      },
      $transaction: vi.fn(async (cb: (tx: typeof prisma) => Promise<void>) => cb(prisma)),
    } as unknown as PrismaClient;

    const outcome = await reconcileProviderCleanupIntent(
      { prisma, sandbox: { destroy } as never, home: home as never, dataDir: "./data" },
      { workspaceId: "ws-1", sessionBotId: "bot-a", lifecycleAction: "stop:idle" },
    );
    expect(outcome).toBe("resolved");
    expect(destroy).toHaveBeenCalledOnce();
    expect(cancelSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "cancelled" }) }),
    );
    finalizeSpy.mockRestore();
  });

  it("keeps destroy intent pending when finalize fails after provider success", async () => {
    const session = {
      botId: "bot-a",
      state: "deleting",
      providerRef: "box-a",
      bootClaimToken: "delete-token",
      computer: { id: "comp-1", kind: "box" },
      computerId: "comp-1",
      controlHolder: "none",
      controlLeaseId: null,
      controlLeaseExpiresAt: null,
    };
    const destroy = vi.fn(async () => undefined);
    const home = { resolve: vi.fn(() => "/data/homes/bot-a") };
    const resolveIntent = vi.fn(async () => ({ count: 1 }));
    const finalizeSpy = vi
      .spyOn(botDestroyFinalize, "finalizeBotDestroyAfterProvider")
      .mockResolvedValue(false);
    const prisma = {
      desktopSession: {
        findUnique: vi.fn(async () => session),
        updateMany: vi.fn(async () => ({ count: 1 })),
        findMany: vi.fn(async () => []),
      },
      run: { count: vi.fn(async () => 0) },
      orphanProvision: {
        findFirst: vi.fn(async () =>
          lifecycleRow({
            lifecycleAction: "destroy:delete",
            lifecycleToken: "delete-token",
            refSnapshotProviderRef: "box-a",
            reason: cleanupIntentReason("destroy:delete"),
          }),
        ),
        updateMany: resolveIntent,
      },
    } as unknown as PrismaClient;

    const outcome = await reconcileProviderCleanupIntent(
      { prisma, sandbox: { destroy } as never, home: home as never },
      { workspaceId: "ws-1", sessionBotId: "bot-a", lifecycleAction: "stop:idle" },
    );
    expect(outcome).toBe("pending");
    expect(destroy).toHaveBeenCalledOnce();
    expect(resolveIntent).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "resolved" }) }),
    );
    finalizeSpy.mockRestore();
  });
});

describe("intent helpers", () => {
  it("detects lifecycle cleanup rows", () => {
    expect(isProviderCleanupIntent(lifecycleRow())).toBe(true);
    expect(cleanupActionFromRow(lifecycleRow())).toBe("stop:idle");
  });

  it("cancels pending intent only when lifecycle token matches", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = { orphanProvision: { updateMany } } as unknown as PrismaClient;
    await cancelLifecycleCleanupIntent(prisma, {
      workspaceId: "ws-1",
      sessionBotId: "bot-a",
      lifecycleToken: "suspend-token",
      lifecycleAction: "stop:idle",
      reason: "reactivated",
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "pending",
          sessionBotId: "bot-a",
          lifecycleToken: "suspend-token",
          lifecycleAction: "stop:idle",
        }),
        data: expect.objectContaining({ status: "cancelled" }),
      }),
    );
  });

  it("leaves row intact when lifecycle token mismatches", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const prisma = { orphanProvision: { updateMany } } as unknown as PrismaClient;
    const cancelled = await cancelLifecycleCleanupIntent(prisma, {
      workspaceId: "ws-1",
      sessionBotId: "bot-a",
      lifecycleToken: "stale-token",
      lifecycleAction: "stop:idle",
      reason: "reactivated",
    });
    expect(cancelled).toBe(false);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ lifecycleToken: "stale-token" }),
      }),
    );
  });
});

describe("shared provider ref lifecycle identities", () => {
  const sharedDockerRef = {
    id: "container-ws",
    botId: "bot-a",
    kind: "docker" as const,
    providerRef: "container-ws",
  };

  function lifecycleIntentStore() {
    const rows = new Map<string, Record<string, unknown>>();
    const key = (workspaceId: string, sessionBotId: string, lifecycleAction: string) =>
      `${workspaceId}:${sessionBotId}:${lifecycleAction}`;

    const findFirst = vi.fn(
      async ({
        where,
      }: {
        where: { workspaceId: string; sessionBotId: string; lifecycleAction: string };
      }) => {
        const row = rows.get(key(where.workspaceId, where.sessionBotId, where.lifecycleAction));
        if (!row) return null;
        return { id: key(where.workspaceId, where.sessionBotId, where.lifecycleAction), ...row };
      },
    );
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const k = key(
        String(data.workspaceId),
        String(data.sessionBotId),
        String(data.lifecycleAction),
      );
      if (rows.has(k)) {
        throw Object.assign(new Error("unique"), { code: "P2002" });
      }
      rows.set(k, { ...data });
    });
    const update = vi.fn(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.get(where.id);
        if (!row) return;
        rows.set(where.id, { ...row, ...data });
      },
    );

    const updateMany = vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        let count = 0;
        for (const [k, row] of rows.entries()) {
          const matches =
            row.workspaceId === where.workspaceId &&
            row.sessionBotId === where.sessionBotId &&
            row.lifecycleAction === where.lifecycleAction &&
            row.lifecycleToken === where.lifecycleToken &&
            row.status === where.status;
          if (matches) {
            rows.set(k, { ...row, ...data });
            count += 1;
          }
        }
        return { count };
      },
    );

    const orphanProvision = { findFirst, create, update, updateMany };
    const prisma = {
      orphanProvision,
      $transaction: vi.fn(async (cb: (tx: typeof prisma) => Promise<void>) => cb(prisma)),
    };

    return {
      ...orphanProvision,
      prisma: prisma as unknown as PrismaClient,
      get(sessionBotId: string, lifecycleAction: string) {
        return rows.get(key("ws-1", sessionBotId, lifecycleAction));
      },
    };
  }

  it("keeps separate lifecycle intents for two docker bots on the same providerRef", async () => {
    const store = lifecycleIntentStore();
    const prisma = store.prisma;

    await recordLifecycleCleanupIntent(prisma, {
      ref: sharedDockerRef,
      action: "destroy:delete",
      lifecycleToken: "delete-a",
      sessionBotId: "bot-a",
      workspaceId: "ws-1",
      reason: cleanupIntentReason("destroy:delete"),
    });
    await recordLifecycleCleanupIntent(prisma, {
      ref: { ...sharedDockerRef, botId: "bot-b" },
      action: "stop:idle",
      lifecycleToken: "suspend-b",
      sessionBotId: "bot-b",
      workspaceId: "ws-1",
      reason: cleanupIntentReason("stop:idle"),
    });

    expect(store.get("bot-a", "destroy:delete")?.lifecycleToken).toBe("delete-a");
    expect(store.get("bot-b", "stop:idle")?.lifecycleToken).toBe("suspend-b");
    expect(store.create).toHaveBeenCalledTimes(2);
  });

  it("does not clobber bot B token when recording bot A lifecycle intent", async () => {
    const store = lifecycleIntentStore();
    const prisma = store.prisma;

    await recordLifecycleCleanupIntent(prisma, {
      ref: { ...sharedDockerRef, botId: "bot-b" },
      action: "stop:idle",
      lifecycleToken: "suspend-b",
      sessionBotId: "bot-b",
      workspaceId: "ws-1",
      reason: cleanupIntentReason("stop:idle"),
    });
    await recordLifecycleCleanupIntent(prisma, {
      ref: sharedDockerRef,
      action: "destroy:delete",
      lifecycleToken: "delete-a",
      sessionBotId: "bot-a",
      workspaceId: "ws-1",
      reason: cleanupIntentReason("destroy:delete"),
    });

    expect(store.get("bot-b", "stop:idle")?.lifecycleToken).toBe("suspend-b");
    expect(store.get("bot-a", "destroy:delete")?.lifecycleToken).toBe("delete-a");
  });

  it("resolves only the targeted bot lifecycle intent", async () => {
    const store = lifecycleIntentStore();
    const prisma = store.prisma;

    await recordLifecycleCleanupIntent(prisma, {
      ref: sharedDockerRef,
      action: "destroy:delete",
      lifecycleToken: "delete-a",
      sessionBotId: "bot-a",
      workspaceId: "ws-1",
      reason: cleanupIntentReason("destroy:delete"),
    });
    await recordLifecycleCleanupIntent(prisma, {
      ref: { ...sharedDockerRef, botId: "bot-b" },
      action: "stop:idle",
      lifecycleToken: "suspend-b",
      sessionBotId: "bot-b",
      workspaceId: "ws-1",
      reason: cleanupIntentReason("stop:idle"),
    });

    const resolved = await resolveLifecycleCleanupIntent(prisma, {
      workspaceId: "ws-1",
      sessionBotId: "bot-a",
      lifecycleAction: "destroy:delete",
      lifecycleToken: "delete-a",
    });

    expect(resolved).toBe(true);
    expect(store.get("bot-a", "destroy:delete")?.status).toBe("resolved");
    expect(store.get("bot-b", "stop:idle")?.status).toBe("pending");
  });

  it("allows boot-orphan row alongside lifecycle intent on the same providerRef", async () => {
    const lifecycleStore = lifecycleIntentStore();
    const bootRows: Record<string, unknown>[] = [];
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const orphanProvision = {
      findFirst: lifecycleStore.findFirst,
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        if (args.data.lifecycleAction) {
          await lifecycleStore.create(args);
          return;
        }
        bootRows.push(args.data);
      }),
      update: lifecycleStore.update,
      updateMany,
    };
    const prisma = {
      orphanProvision,
      $transaction: vi.fn(async (cb: (tx: typeof prisma) => Promise<void>) => cb(prisma)),
    } as unknown as PrismaClient;

    await recordLifecycleCleanupIntent(prisma, {
      ref: sharedDockerRef,
      action: "destroy:delete",
      lifecycleToken: "delete-a",
      sessionBotId: "bot-a",
      workspaceId: "ws-1",
      reason: cleanupIntentReason("destroy:delete"),
    });

    const { recordOrphanProvisionForReconciliation } = await import("./computer-boot-provision.js");
    await recordOrphanProvisionForReconciliation(prisma, {
      workspaceId: "ws-1",
      ref: sharedDockerRef,
      reason: "boot orphan retry",
    });

    expect(lifecycleStore.get("bot-a", "destroy:delete")?.status).toBe("pending");
    expect(bootRows).toHaveLength(1);
    expect(bootRows[0]?.lifecycleAction).toBeNull();
  });

  it("retries P2002 on the root client instead of an aborted transaction", async () => {
    const store = lifecycleIntentStore();
    const prisma = store.prisma;
    store.create.mockImplementationOnce(async () => {
      throw Object.assign(new Error("unique"), { code: "P2002" });
    });
    store.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "ws-1:bot-a:destroy:delete",
      workspaceId: "ws-1",
      sessionBotId: "bot-a",
      lifecycleAction: "destroy:delete",
      lifecycleToken: "stale",
      status: "pending",
    } as never);

    await recordLifecycleCleanupIntent(prisma, {
      ref: sharedDockerRef,
      action: "destroy:delete",
      lifecycleToken: "delete-a",
      sessionBotId: "bot-a",
      workspaceId: "ws-1",
      reason: cleanupIntentReason("destroy:delete"),
    });

    expect(store.prisma.$transaction).not.toHaveBeenCalled();
    expect(store.update).toHaveBeenCalledWith({
      where: { id: "ws-1:bot-a:destroy:delete" },
      data: expect.objectContaining({ lifecycleToken: "delete-a" }),
    });
  });
});
