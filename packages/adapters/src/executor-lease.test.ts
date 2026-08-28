import type { WakeupJob } from "@quibt/adapter-kit";
import type { PrismaClient } from "@quibt/db";
import { BillingPolicyError } from "@quibt/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";
import { RUN_LEASE_MS } from "./run-lease.js";

interface RunRow {
  id: string;
  status: string;
  leaseOwner: string | null;
  leaseFence: number;
  leaseExpiresAt: Date | null;
  startedAt: Date | null;
  checkpoint: string | null;
  taskId: string;
  workspaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  trigger: string;
  createdAt: Date;
}

type Where = Record<string, unknown>;

function matches(row: RunRow, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Where[]).some((clause) => matches(row, clause));
    const value = (row as unknown as Record<string, unknown>)[key];
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      const filter = condition as Record<string, unknown>;
      if ("in" in filter) return (filter.in as unknown[]).includes(value);
      if ("notIn" in filter) return !(filter.notIn as unknown[]).includes(value);
      if ("lt" in filter) {
        if (!value) return false;
        return (value as Date).getTime() < (filter.lt as Date).getTime();
      }
      if ("not" in filter) return value !== filter.not;
      if ("gt" in filter) {
        if (!value) return false;
        return (value as Date).getTime() > (filter.gt as Date).getTime();
      }
      if ("contains" in filter) return String(value ?? "").includes(String(filter.contains));
      throw new Error(`unsupported filter ${JSON.stringify(filter)}`);
    }
    return value === condition;
  });
}

function executorFor(
  rows: RunRow[],
  peerText?: string,
  hooks?: { beforeBilling?: () => void | Promise<void> },
) {
  const enqueued: WakeupJob[] = [];
  const prisma = {
    run: {
      findUnique: vi.fn(
        async ({ where }: { where: Where }) => rows.find((r) => matches(r, where)) ?? null,
      ),
      findFirst: vi.fn(async ({ where }: { where: Where }) => {
        const found = rows
          .filter((r) => matches(r, where))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return found[0] ?? null;
      }),
      findMany: vi.fn(async ({ where }: { where: Where }) => rows.filter((r) => matches(r, where))),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<RunRow> }) => {
        let count = 0;
        for (const row of rows) {
          if (!matches(row, where)) continue;
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      }),
      update: vi.fn(async ({ where, data }: { where: Where; data: Partial<RunRow> }) => {
        const row = rows.find((r) => matches(r, where)) ?? rows[0]!;
        Object.assign(row, data);
        return row;
      }),
    },
    attempt: { create: vi.fn(async () => ({ id: "attempt-1" })) },
    message: {
      findFirst: vi.fn(async () =>
        peerText === undefined ? null : { blocks: [{ kind: "text", text: peerText }] },
      ),
    },
    task: { update: vi.fn(async () => ({ id: "task-1" })) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    event: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        id: "event-1",
        createdAt: new Date(),
      })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (arg: unknown) =>
      typeof arg === "function"
        ? (arg as (tx: unknown) => Promise<unknown>)(prisma)
        : Promise.all(arg as Promise<unknown>[]),
    ),
  };
  const runtime = {
    describe: vi.fn(() => ({ capabilities: { tools: true, scripted: false } })),
    run: vi.fn(),
    abort: vi.fn(async () => undefined),
  };
  const wakeup = {
    describe: () => ({
      id: "f",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { cron: true, delay: true },
    }),
    enqueue: vi.fn(async (job: WakeupJob) => {
      enqueued.push(job);
    }),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const executor = createRunExecutor({
    prisma: prisma as unknown as PrismaClient,
    runtime: runtime as never,
    sandbox: {} as never,
    memory: {} as never,
    home: {} as never,
    secrets: [],
    wakeup,
    // The turn stops right after the lease so the test never reaches the agent runtime.
    billing: {
      assertWithinPlan: async () => {
        await hooks?.beforeBilling?.();
        throw new BillingPolicyError("tokens", "sem tokens");
      },
    },
  });
  return { executor, prisma, runtime, rows, enqueued };
}

function runningRun(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: "run-1",
    status: "running",
    leaseOwner: "worker-1",
    leaseFence: 1,
    leaseExpiresAt: new Date(Date.now() + RUN_LEASE_MS),
    startedAt: new Date(),
    checkpoint: null,
    taskId: "task-1",
    workspaceId: "w",
    threadId: "t",
    botId: "b",
    userId: "u",
    trigger: "user",
    createdAt: new Date("2026-08-15T12:00:00.000Z"),
    ...overrides,
  };
}

describe("continueRun lease", () => {
  it("does not run the agent twice when a second continue lands on a running run", async () => {
    const { executor, prisma, rows } = executorFor([runningRun()]);
    await executor.continueRun("run-1", "worker-2");
    expect(prisma.attempt.create).not.toHaveBeenCalled();
    expect(prisma.userModelCredential.findFirst).not.toHaveBeenCalled();
    expect(rows[0]!).toMatchObject({ status: "running", leaseOwner: "worker-1", leaseFence: 1 });
  });

  it("does not fail a run another worker already stole", async () => {
    const { executor, prisma, rows } = executorFor(
      [runningRun({ leaseExpiresAt: new Date(Date.now() - 1) })],
      undefined,
      {
        beforeBilling: () => {
          rows[0]!.leaseFence = 99;
          rows[0]!.leaseOwner = "worker-3";
          rows[0]!.status = "running";
        },
      },
    );
    await executor.continueRun("run-1", "worker-2");
    expect(rows[0]!).toMatchObject({ status: "running", leaseOwner: "worker-3", leaseFence: 99 });
    expect(prisma.task.update).not.toHaveBeenCalled();
  });

  it("takes the run over once the previous worker's lease expired", async () => {
    const { executor, prisma, rows } = executorFor([
      runningRun({ leaseExpiresAt: new Date(Date.now() - 1) }),
    ]);
    await executor.continueRun("run-1", "worker-2");
    expect(prisma.attempt.create).toHaveBeenCalledWith({
      data: { runId: "run-1", fence: 2, status: "running" },
    });
    // The billing stub fails the run, which proves the turn really started.
    expect(rows[0]!).toMatchObject({ status: "failed", leaseOwner: null, leaseFence: 2 });
  });

  it("ignores a continue for a run that already finished", async () => {
    const { executor, prisma } = executorFor([runningRun({ status: "completed" })]);
    await executor.continueRun("run-1", "worker-2");
    expect(prisma.run.updateMany).not.toHaveBeenCalled();
  });
});

describe("continueRun peer wait", () => {
  const askerCheckpoint = JSON.stringify({
    pendingPeer: {
      peerRunId: "run-2",
      botId: "bot-2",
      botName: "Scout",
      question: "e ai?",
      executionId: "exec-1",
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });

  it("gives the worker slot back while the teammate is still working", async () => {
    const { executor, prisma, rows } = executorFor([
      runningRun({
        status: "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
        leaseFence: 0,
        checkpoint: askerCheckpoint,
      }),
      runningRun({ id: "run-2", status: "running", botId: "b2" }),
    ]);
    await executor.continueRun("run-1", "worker-2");
    expect(rows[0]).toMatchObject({
      status: "waiting_input",
      checkpoint: askerCheckpoint,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(prisma.attempt.create).not.toHaveBeenCalled();
    // Nothing heavy ran: no model credential lookup, no computer boot.
    expect(prisma.userModelCredential.findFirst).not.toHaveBeenCalled();
  });

  it("resumes with the answer once the teammate finished", async () => {
    const { executor, prisma, rows } = executorFor(
      [
        runningRun({
          status: "queued",
          leaseOwner: null,
          leaseExpiresAt: null,
          leaseFence: 0,
          checkpoint: askerCheckpoint,
        }),
        runningRun({ id: "run-2", status: "completed", botId: "b2" }),
      ],
      "é no centro",
    );
    await executor.continueRun("run-1", "worker-2");
    expect(rows[0]!.checkpoint).toBeNull();
    expect(prisma.userModelCredential.findFirst).toHaveBeenCalled();
  });
});

describe("one agent per bot", () => {
  const busyPeer = (overrides: Partial<RunRow> = {}) =>
    runningRun({
      id: "run-a",
      status: "running",
      leaseOwner: "worker-1",
      leaseFence: 4,
      leaseExpiresAt: new Date(Date.now() + RUN_LEASE_MS),
      createdAt: new Date("2026-08-15T11:00:00.000Z"),
      ...overrides,
    });
  const queuedRun = (overrides: Partial<RunRow> = {}) =>
    runningRun({
      id: "run-b",
      status: "queued",
      leaseOwner: null,
      leaseFence: 0,
      leaseExpiresAt: null,
      startedAt: null,
      ...overrides,
    });

  it("parks the second message while the bot is already working", async () => {
    const { executor, prisma, rows, enqueued } = executorFor([queuedRun(), busyPeer()]);
    await executor.continueRun("run-b", "worker-2");
    expect(prisma.attempt.create).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ status: "queued", leaseFence: 0 });
    // Parked, not lost: a retry wake is scheduled under a per-run key.
    expect(enqueued).toEqual([
      expect.objectContaining({
        name: "run.continue",
        payload: { runId: "run-b" },
        jobKey: "run.continue:run-b",
      }),
    ]);
    expect(enqueued[0]!.runAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("wakes the bot's oldest queued run when the current turn ends", async () => {
    const { executor, rows, enqueued } = executorFor([
      busyPeer({ id: "run-a", leaseExpiresAt: new Date(Date.now() - 1) }),
      queuedRun({ id: "run-b", createdAt: new Date("2026-08-15T12:30:00.000Z") }),
      queuedRun({ id: "run-c", createdAt: new Date("2026-08-15T12:10:00.000Z") }),
    ]);
    // run-a takes its own (expired) lease, the billing stub fails it, and the bot frees up.
    await executor.continueRun("run-a", "worker-2");
    expect(rows[0]!.status).toBe("failed");
    expect(enqueued).toContainEqual(
      expect.objectContaining({ name: "run.continue", payload: { runId: "run-c" } }),
    );
    expect(enqueued).not.toContainEqual(expect.objectContaining({ payload: { runId: "run-b" } }));
  });

  it("does not let a dead lease lock the bot", async () => {
    const { executor, prisma } = executorFor([
      queuedRun(),
      busyPeer({ leaseExpiresAt: new Date(Date.now() - 1) }),
    ]);
    await executor.continueRun("run-b", "worker-2");
    expect(prisma.attempt.create).toHaveBeenCalled();
  });

  it("keeps different bots running in parallel", async () => {
    const { executor, prisma } = executorFor([queuedRun(), busyPeer({ botId: "other-bot" })]);
    await executor.continueRun("run-b", "worker-2");
    expect(prisma.attempt.create).toHaveBeenCalled();
  });

  it("never blocks the bot's own paused run from resuming", async () => {
    const { executor, prisma } = executorFor([
      queuedRun({ id: "run-b", status: "waiting_input" }),
      busyPeer({ id: "run-a", status: "waiting_takeover" }),
    ]);
    await executor.continueRun("run-b", "worker-2");
    expect(prisma.attempt.create).toHaveBeenCalled();
  });
});

/**
 * The lease is acquired before discovery, MCP and the first boot of the computer, and those
 * can take minutes. While the renewal only started with the stream, any boot longer than
 * `RUN_LEASE_MS` let the reaper requeue a run that was still booting: a second worker booted
 * the same bot again, and three of those cycles failed the run.
 */
describe("lease during a slow boot", () => {
  const bootingRun = (overrides: Partial<RunRow> = {}) =>
    runningRun({
      status: "queued",
      leaseOwner: null,
      leaseFence: 0,
      leaseExpiresAt: null,
      startedAt: null,
      ...overrides,
    });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps renewing through a boot longer than the lease window, so no second worker starts the same run", async () => {
    vi.useFakeTimers();
    let finishBoot!: () => void;
    const booting = new Promise<void>((resolve) => {
      finishBoot = resolve;
    });
    const { executor, prisma, rows } = executorFor([bootingRun()], undefined, {
      beforeBilling: () => booting,
    });

    const turn = executor.continueRun("run-1", "worker-1");
    // 90 s of boot: past one whole lease window.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(rows[0]!.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());

    // A second worker arrives mid-boot and must find the run still owned.
    await executor.continueRun("run-1", "worker-2");
    expect(prisma.attempt.create).toHaveBeenCalledTimes(1);
    expect(rows[0]!).toMatchObject({ leaseOwner: "worker-1", leaseFence: 1 });

    finishBoot();
    await turn;
  });

  it("stops the watcher when the turn ends", async () => {
    vi.useFakeTimers();
    const { executor, prisma, rows } = executorFor([bootingRun()]);
    // The billing stub fails the run, which is the ordinary end of a turn here.
    await executor.continueRun("run-1", "worker-1");
    expect(rows[0]!.status).toBe("failed");

    const renewals = prisma.run.updateMany.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(prisma.run.updateMany.mock.calls.length).toBe(renewals);
  });

  it("stops the watcher when the run parks waiting for a teammate", async () => {
    vi.useFakeTimers();
    const checkpoint = JSON.stringify({
      pendingPeer: {
        peerRunId: "run-2",
        botId: "bot-2",
        botName: "Scout",
        question: "e ai?",
        executionId: "exec-1",
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    const { executor, prisma, rows } = executorFor([
      bootingRun({ checkpoint }),
      runningRun({ id: "run-2", status: "running", botId: "b2" }),
    ]);

    await executor.continueRun("run-1", "worker-1");
    expect(rows[0]!).toMatchObject({ status: "waiting_input" });

    const renewals = prisma.run.updateMany.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(prisma.run.updateMany.mock.calls.length).toBe(renewals);
  });

  it("stops the watcher when the boot throws", async () => {
    vi.useFakeTimers();
    const { executor, prisma } = executorFor([bootingRun()], undefined, {
      beforeBilling: () => {
        throw new Error("discovery exploded");
      },
    });

    await expect(executor.continueRun("run-1", "worker-1")).rejects.toThrow("discovery exploded");

    const renewals = prisma.run.updateMany.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(prisma.run.updateMany.mock.calls.length).toBe(renewals);
  });
});
