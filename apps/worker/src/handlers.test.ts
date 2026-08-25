import type { WakeupJob } from "@quibt/adapter-kit";
import * as adapters from "@quibt/adapters";
import type { PrismaClient } from "@quibt/db";
import { describe, expect, it, vi } from "vitest";
import { createWakeupHandlers } from "./handlers.js";

function harness(options?: { reapFails?: boolean }) {
  const enqueued: Array<Record<string, unknown>> = [];
  const released: Array<Record<string, unknown>> = [];
  const prisma = {
    run: {
      findMany: vi.fn(async () => {
        if (options?.reapFails) throw new Error("db down");
        return [];
      }),
      findFirst: vi.fn(async () => ({ id: "run-9" })),
    },
    desktopSession: {
      findMany: vi.fn(async () => [{ botId: "bot-1", controlFence: 2 }]),
      updateMany: vi.fn(async (args: Record<string, unknown>) => {
        released.push(args);
        return { count: 1 };
      }),
    },
    orphanProvision: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
    },
  } as unknown as PrismaClient;
  const wakeup = {
    describe: () => ({
      id: "f",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { cron: true, delay: true },
    }),
    enqueue: vi.fn(async (job: WakeupJob) => {
      enqueued.push(job as unknown as Record<string, unknown>);
    }),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const executor = {
    continueRun: vi.fn(async () => undefined),
    wakeRoutine: vi.fn(async () => undefined),
  };
  const handlers = createWakeupHandlers({
    prisma,
    sandbox: {} as never,
    wakeup,
    executor,
    workerId: "worker-7",
  });
  return { handlers, enqueued, executor, prisma, released };
}

describe("worker wakeup handlers", () => {
  it("registers the lease reaper next to the existing tasks", () => {
    const { handlers } = harness();
    expect(Object.keys(handlers).sort()).toEqual([
      "computer.sleep",
      "control.reap",
      "orphan.reconcile",
      "routine.wakeup",
      "run.continue",
      "run.reap",
    ]);
  });

  it("passes the worker id along to the executor", async () => {
    const { handlers, executor } = harness();
    await handlers["run.continue"]!({ runId: "run-1" });
    await handlers["routine.wakeup"]!({ routineId: "routine-1" });
    expect(executor.continueRun).toHaveBeenCalledWith("run-1", "worker-7");
    expect(executor.wakeRoutine).toHaveBeenCalledWith("routine-1", "worker-7");
  });

  it("reaps expired leases and reschedules itself", async () => {
    const { handlers, enqueued, prisma } = harness();
    await handlers["run.reap"]!({});
    expect(prisma.run.findMany).toHaveBeenCalled();
    expect(enqueued).toEqual([expect.objectContaining({ name: "run.reap", jobKey: "run.reap" })]);
  });

  it("keeps the reaper loop alive when a sweep fails", async () => {
    const { handlers, enqueued } = harness({ reapFails: true });
    await expect(handlers["run.reap"]!({})).rejects.toThrow("db down");
    expect(enqueued).toEqual([expect.objectContaining({ name: "run.reap", jobKey: "run.reap" })]);
  });

  it("reconciles pending orphan intents and reschedules itself", async () => {
    const reconcile = vi.spyOn(adapters, "reconcilePendingProviderCleanups").mockResolvedValue(2);
    const { handlers, enqueued } = harness();
    await handlers["orphan.reconcile"]!({});
    expect(reconcile).toHaveBeenCalled();
    expect(enqueued).toEqual([
      expect.objectContaining({ name: "orphan.reconcile", jobKey: "orphan.reconcile" }),
    ]);
    reconcile.mockRestore();
  });
});

describe("control.reap", () => {
  it("gives the computer back to the bot and wakes the run parked on the takeover", async () => {
    const { handlers, enqueued, released } = harness();
    await handlers["control.reap"]!({ botId: "bot-1" });
    expect(released).toEqual([
      {
        where: { botId: "bot-1", controlFence: 2, controlHolder: "user" },
        data: {
          controlHolder: "bot",
          controlLeaseId: null,
          controlLeaseUserId: null,
          controlLeaseExpiresAt: null,
        },
      },
    ]);
    expect(enqueued).toEqual([
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-9" } }),
    ]);
  });
});
