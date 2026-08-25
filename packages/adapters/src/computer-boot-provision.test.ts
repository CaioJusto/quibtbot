import type { ComputerRef } from "@quibt/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BootClaimLostError, withBootClaimHeartbeat } from "./computer-boot-claim.js";
import {
  combineAbortSignals,
  destroyOrphanProvisionIfSafe,
  ProvisionBootTimeoutError,
  recordOrphanProvisionForReconciliation,
  runProvisionWithTimeout,
  trackPromise,
} from "./computer-boot-provision.js";

describe("combineAbortSignals", () => {
  it("aborts when parent signal aborts", () => {
    const parent = new AbortController();
    const combined = combineAbortSignals(parent.signal);
    parent.abort();
    expect(combined.aborted).toBe(true);
    combined.dispose();
  });
});

describe("trackPromise", () => {
  it("reports late settlement without unhandled rejections", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let rejectLate!: (error: Error) => void;
      const source = new Promise<ComputerRef>((_, reject) => {
        rejectLate = reject;
      });
      const tracked = trackPromise(source);
      rejectLate(new Error("late reject"));
      await expect(tracked.promise).rejects.toThrow("late reject");
      const late = await tracked.awaitLate(10);
      expect(late.status).toBe("rejected");
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("runProvisionWithTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out a hung provision and stops waiting", async () => {
    const hung = new Promise<ComputerRef>(() => undefined);
    await expect(runProvisionWithTimeout(() => hung, { timeoutMs: 25 })).rejects.toBeInstanceOf(
      ProvisionBootTimeoutError,
    );
  });

  it("times out with fake timers without leaving pending timers", async () => {
    vi.useFakeTimers();
    const hung = new Promise<ComputerRef>(() => undefined);
    const task = runProvisionWithTimeout(() => hung, { timeoutMs: 1000 });
    const assertion = expect(task).rejects.toBeInstanceOf(ProvisionBootTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("invokes onLateResolve after catch without blocking when settlement is late", async () => {
    const destroyed = vi.fn();
    let resolveLate!: (v: ComputerRef) => void;
    const late = new Promise<ComputerRef>((resolve) => {
      resolveLate = resolve;
    });
    await expect(
      runProvisionWithTimeout(() => late, { timeoutMs: 25, onLateResolve: destroyed }),
    ).rejects.toBeInstanceOf(ProvisionBootTimeoutError);
    expect(destroyed).not.toHaveBeenCalled();
    resolveLate({
      id: "late",
      botId: "bot-a",
      kind: "docker",
      providerRef: "late-ref",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(destroyed).toHaveBeenCalledOnce();
  });

  it("cleans up when a late provision resolves after timeout", async () => {
    const destroyed = vi.fn();
    const late = new Promise<ComputerRef>((resolve) => {
      setTimeout(
        () =>
          resolve({
            id: "late",
            botId: "bot-a",
            kind: "docker",
            providerRef: "late-ref",
          }),
        30,
      );
    });
    await expect(
      runProvisionWithTimeout(() => late, {
        timeoutMs: 25,
        onLateResolve: destroyed,
      }),
    ).rejects.toBeInstanceOf(ProvisionBootTimeoutError);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(destroyed).toHaveBeenCalledOnce();
  });

  it("captures late rejection without unhandled rejections", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const onLateReject = vi.fn();
      const late = new Promise<ComputerRef>((_, reject) => {
        setTimeout(() => reject(new Error("late fail")), 30);
      });
      await expect(
        runProvisionWithTimeout(() => late, {
          timeoutMs: 25,
          onLateReject,
        }),
      ).rejects.toBeInstanceOf(ProvisionBootTimeoutError);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(onLateReject).toHaveBeenCalledOnce();
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("aborts when parent signal aborts before timeout", async () => {
    const parent = new AbortController();
    const hung = new Promise<ComputerRef>(() => undefined);
    const onLateResolve = vi.fn();
    const task = runProvisionWithTimeout(() => hung, {
      timeoutMs: 5000,
      parentSignal: parent.signal,
      onLateResolve,
    });
    parent.abort();
    await expect(task).rejects.toThrow();
    expect(onLateResolve).not.toHaveBeenCalled();
  });
});

describe("withBootClaimHeartbeat", () => {
  it("stops renewing when stopWhen aborts", async () => {
    const renew = vi.fn(async () => true);
    const abort = new AbortController();
    const task = withBootClaimHeartbeat(
      renew,
      async () => {
        await new Promise((r) => setTimeout(r, 40));
        return "ok";
      },
      { intervalMs: 5, stopWhen: abort.signal },
    );
    setTimeout(() => abort.abort(), 10);
    await expect(task).resolves.toBe("ok");
    expect(renew.mock.calls.length).toBeLessThan(8);
  });

  it("aborts provision when renew loses the claim without unhandled rejections", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const abort = new AbortController();
      let aborted = false;
      const renew = vi.fn(async () => false);
      await expect(
        withBootClaimHeartbeat(
          renew,
          async () => {
            await new Promise<void>((resolve, reject) => {
              abort.signal.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  reject(new Error("aborted"));
                },
                { once: true },
              );
              setTimeout(resolve, 200);
            });
          },
          { intervalMs: 10, abortOnLostClaim: abort },
        ),
      ).rejects.toBeInstanceOf(BootClaimLostError);
      expect(aborted).toBe(true);
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("catches renew rejections without unhandled rejections", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const abort = new AbortController();
      const renew = vi.fn(async () => {
        throw new Error("db down");
      });
      await expect(
        withBootClaimHeartbeat(
          renew,
          async () => new Promise((resolve) => setTimeout(resolve, 100)),
          { intervalMs: 10, abortOnLostClaim: abort },
        ),
      ).rejects.toBeInstanceOf(BootClaimLostError);
      expect(abort.signal.aborted).toBe(true);
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("throws BootClaimLostError carrying result when lost after fn resolves", async () => {
    const abort = new AbortController();
    let renewCount = 0;
    const provisionRef: ComputerRef = {
      id: "provisioned",
      botId: "bot-a",
      kind: "box",
      providerRef: "orphan-after-provision",
    };
    const renew = vi.fn(async () => {
      renewCount += 1;
      if (renewCount >= 2) return false;
      return true;
    });

    try {
      await withBootClaimHeartbeat(
        renew,
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 35));
          return provisionRef;
        },
        { intervalMs: 10, abortOnLostClaim: abort },
      );
      expect.fail("expected BootClaimLostError");
    } catch (error) {
      expect(error).toBeInstanceOf(BootClaimLostError);
      expect((error as BootClaimLostError<ComputerRef>).result).toEqual(provisionRef);
    }
  });

  it("lets caller recover provision result and run orphan cleanup after lost claim", async () => {
    const abort = new AbortController();
    let renewCount = 0;
    const destroyed = vi.fn(async (_ref: ComputerRef) => undefined);
    const provisionRef: ComputerRef = {
      id: "provisioned",
      botId: "bot-a",
      kind: "box",
      providerRef: "orphan-after-provision",
    };
    const renew = vi.fn(async () => {
      renewCount += 1;
      if (renewCount >= 2) return false;
      return true;
    });

    let provisionedRef: ComputerRef | null = null;
    try {
      provisionedRef = await withBootClaimHeartbeat(
        renew,
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 35));
          return provisionRef;
        },
        { intervalMs: 10, abortOnLostClaim: abort },
      );
    } catch (error) {
      if (error instanceof BootClaimLostError && error.result) {
        provisionedRef = error.result as ComputerRef;
        await destroyed(provisionedRef);
      }
      expect(error).toBeInstanceOf(BootClaimLostError);
    }

    expect(provisionedRef).toEqual(provisionRef);
    expect(destroyed).toHaveBeenCalledOnce();
    expect(destroyed).toHaveBeenCalledWith(provisionRef);
  });
});

describe("destroyOrphanProvisionIfSafe", () => {
  const ref: ComputerRef = {
    id: "orphan",
    botId: "bot-a",
    kind: "docker",
    providerRef: "shared-winner",
  };

  it("does not destroy a shared ref that matches the active computer winner", async () => {
    const destroy = vi.fn(async () => undefined);
    const sandbox = { destroy } as never;
    const prisma = {
      computer: {
        findUnique: async () => ({
          state: "running",
          providerRef: "shared-winner",
          bootClaimToken: "other-token",
        }),
      },
      desktopSession: { findUnique: async () => null },
    } as never;

    await destroyOrphanProvisionIfSafe({
      prisma,
      sandbox,
      context: {},
      ref,
      kind: "docker",
      workspaceId: "ws-1",
      computerClaim: { workspaceId: "ws-1", token: "lost-token" },
    });
    expect(destroy).not.toHaveBeenCalled();
  });

  it("destroys a shared orphan with a distinct providerRef", async () => {
    const destroy = vi.fn(async () => undefined);
    const sandbox = { destroy } as never;
    const prisma = {
      computer: {
        findUnique: async () => ({
          state: "running",
          providerRef: "shared-winner",
          bootClaimToken: "winner-token",
        }),
      },
      desktopSession: { findUnique: async () => null },
    } as never;

    await destroyOrphanProvisionIfSafe({
      prisma,
      sandbox,
      context: {},
      ref: { ...ref, providerRef: "orphan-distinct" },
      kind: "docker",
      workspaceId: "ws-1",
      computerClaim: { workspaceId: "ws-1", token: "lost-token" },
    });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("destroys per-bot orphans that are not the running session ref", async () => {
    const destroy = vi.fn(async () => undefined);
    const sandbox = { destroy } as never;
    const prisma = {
      computer: { findUnique: async () => null },
      desktopSession: {
        findUnique: async () => ({
          state: "running",
          providerRef: "box-winner",
        }),
      },
    } as never;

    await destroyOrphanProvisionIfSafe({
      prisma,
      sandbox,
      context: {},
      ref: { ...ref, kind: "box", providerRef: "box-orphan" },
      kind: "box",
      workspaceId: "ws-1",
      desktopClaim: { botId: "bot-a", token: "lost" },
    });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("waits for another boot claim and skips destroy when active ref matches", async () => {
    const destroy = vi.fn(async () => undefined);
    const sandbox = { destroy } as never;
    let state = "booting";
    let providerRef: string | null = null;
    const prisma = {
      computer: { findUnique: async () => null },
      desktopSession: {
        findUnique: async () => ({
          state,
          providerRef,
          bootClaimToken: "winner-token",
          botId: "bot-a",
          display: 1,
          computer: { kind: "box", providerRef: null },
        }),
      },
    } as never;

    setTimeout(() => {
      state = "running";
      providerRef = "box-winner";
    }, 30);

    await destroyOrphanProvisionIfSafe({
      prisma,
      sandbox,
      context: {},
      ref: { ...ref, kind: "box", providerRef: "box-winner" },
      kind: "box",
      workspaceId: "ws-1",
      desktopClaim: { botId: "bot-a", token: "lost-token" },
      cleanupWaitMs: 200,
    });
    expect(destroy).not.toHaveBeenCalled();
  });

  it("records reconciliation instead of destroying when wait times out", async () => {
    const destroy = vi.fn(async () => undefined);
    const sandbox = { destroy } as never;
    const create = vi.fn(async () => ({}));
    const prisma = {
      computer: { findUnique: async () => null },
      desktopSession: {
        findUnique: async () => ({
          state: "booting",
          providerRef: null,
          bootClaimToken: "winner-token",
          botId: "bot-a",
          display: 1,
          computer: { kind: "box", providerRef: null },
        }),
      },
      orphanProvision: { create },
    } as never;

    await destroyOrphanProvisionIfSafe({
      prisma,
      sandbox,
      context: {},
      ref: { ...ref, kind: "box", providerRef: "box-orphan" },
      kind: "box",
      workspaceId: "ws-1",
      desktopClaim: { botId: "bot-a", token: "lost-token" },
      cleanupWaitMs: 30,
    });
    expect(destroy).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
  });
});

describe("recordOrphanProvisionForReconciliation", () => {
  it("create omits id so the client can generate cuid", async () => {
    const create = vi.fn(async (args: { data: Record<string, unknown> }) => {
      expect(args.data).not.toHaveProperty("id");
      return { ...args.data, id: "generated-cuid-id", updatedAt: new Date() };
    });
    const prisma = { orphanProvision: { create } } as never;
    await recordOrphanProvisionForReconciliation(prisma, {
      workspaceId: "ws-1",
      ref: {
        id: "x",
        botId: "bot-a",
        kind: "box",
        providerRef: "orphan-ref",
      },
      reason: "test",
    });
    expect(create).toHaveBeenCalledOnce();
    const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data).not.toHaveProperty("id");
  });

  it("creates orphan provision independent of boot claim token", async () => {
    const create = vi.fn(async () => ({}));
    const prisma = { orphanProvision: { create } } as never;
    await recordOrphanProvisionForReconciliation(prisma, {
      workspaceId: "ws-1",
      ref: {
        id: "x",
        botId: "bot-a",
        kind: "box",
        providerRef: "orphan-ref",
      },
      reason: "test",
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "ws-1",
          botId: "bot-a",
          provider: "box",
          providerRef: "orphan-ref",
          status: "pending",
        }),
      }),
    );
  });

  it("records after stale steal when lost token no longer matches", async () => {
    const create = vi.fn(async () => ({}));
    const prisma = { orphanProvision: { create } } as never;
    await recordOrphanProvisionForReconciliation(prisma, {
      workspaceId: "ws-1",
      ref: {
        id: "orphan",
        botId: "bot-a",
        kind: "docker",
        providerRef: "stale-orphan-ref",
      },
      reason: "stale steal orphan cleanup",
    });
    expect(create).toHaveBeenCalledOnce();
    expect(JSON.stringify(create.mock.calls)).not.toContain("bootClaimToken");
  });

  it("creates boot-orphan row without lifecycle fields", async () => {
    const create = vi.fn(async () => ({}));
    const prisma = { orphanProvision: { create } } as never;
    await recordOrphanProvisionForReconciliation(prisma, {
      workspaceId: "ws-1",
      ref: {
        id: "orphan",
        botId: "bot-a",
        kind: "docker",
        providerRef: "container-1",
      },
      reason: "boot orphan retry",
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lifecycleAction: null,
          lifecycleToken: null,
          sessionBotId: null,
          refSnapshotKind: null,
          refSnapshotProviderRef: null,
        }),
      }),
    );
  });

  it("reuses resolved row with stale lifecycle as boot-orphan and clears lifecycle fields", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const create = vi.fn(async () => {
      throw Object.assign(new Error("unique"), { code: "P2002" });
    });
    const prisma = { orphanProvision: { create, updateMany } } as never;
    await recordOrphanProvisionForReconciliation(prisma, {
      workspaceId: "ws-1",
      ref: {
        id: "orphan",
        botId: "bot-a",
        kind: "docker",
        providerRef: "container-1",
      },
      reason: "boot orphan retry",
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lifecycleAction: null,
          lifecycleToken: null,
          sessionBotId: null,
          refSnapshotKind: null,
          refSnapshotProviderRef: null,
        }),
      }),
    );
  });

  it("does not overwrite pending lifecycle destroy intent via CAS update", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const create = vi.fn(async () => {
      throw Object.assign(new Error("unique"), { code: "P2002" });
    });
    const prisma = { orphanProvision: { create, updateMany } } as never;
    await recordOrphanProvisionForReconciliation(prisma, {
      workspaceId: "ws-1",
      ref: {
        id: "orphan",
        botId: "bot-a",
        kind: "box",
        providerRef: "box-a",
      },
      reason: "boot orphan retry",
    });
    expect(create).toHaveBeenCalledOnce();
    expect(updateMany).toHaveBeenCalledOnce();
  });

  it("does not clear lifecycle intent when lifecycle pending wins CAS race after create conflict", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const create = vi.fn(async () => {
      throw Object.assign(new Error("unique"), { code: "P2002" });
    });
    const prisma = { orphanProvision: { create, updateMany } } as never;
    await recordOrphanProvisionForReconciliation(prisma, {
      workspaceId: "ws-1",
      ref: {
        id: "orphan",
        botId: "bot-a",
        kind: "box",
        providerRef: "box-a",
      },
      reason: "boot orphan retry",
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          lifecycleAction: null,
        }),
      }),
    );
  });
});
