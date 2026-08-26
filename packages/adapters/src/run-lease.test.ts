import type { WakeupJob } from "@quibt/adapter-kit";
import type { PrismaClient } from "@quibt/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_STALLED_MESSAGE } from "./llm-retry.js";
import {
  acquireRunLease,
  BOT_BUSY_RETRY_MS,
  botBusyWith,
  busyRetryJobKey,
  deferRunForBusyBot,
  LEGACY_LEASE_GRACE_MS,
  PROVIDER_RETRY_DELAY_MS,
  RUN_LEASE_MS,
  reapExpiredLeases,
  renewRunLease,
  requeueRunAfterProviderError,
  scheduleRunReap,
  wakeNextRunForBot,
  watchRunLease,
} from "./run-lease.js";

interface RunRow {
  id: string;
  createdAt?: Date;
  status: string;
  leaseOwner: string | null;
  leaseFence: number;
  leaseExpiresAt: Date | null;
  updatedAt?: Date;
  taskId?: string;
  workspaceId?: string;
  threadId?: string;
  botId?: string;
}

type Where = Record<string, unknown>;

/** Enough of Prisma's matcher to exercise the compare-and-swap the lease relies on. */
function matches(row: RunRow, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Where[]).some((clause) => matches(row, clause));
    const value = (row as unknown as Record<string, unknown>)[key];
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      const filter = condition as Record<string, unknown>;
      if ("in" in filter) return (filter.in as unknown[]).includes(value);
      if ("notIn" in filter) return !(filter.notIn as unknown[]).includes(value);
      if ("lt" in filter) {
        if (value === null || value === undefined) return false;
        return (value as Date).getTime() < (filter.lt as Date).getTime();
      }
      if ("gt" in filter) {
        if (value === null || value === undefined) return false;
        return (value as Date).getTime() > (filter.gt as Date).getTime();
      }
      if ("not" in filter) return value !== filter.not;
      throw new Error(`unsupported filter ${JSON.stringify(filter)}`);
    }
    return value === condition;
  });
}

function runStore(rows: RunRow[]) {
  const enqueued: Array<Record<string, unknown>> = [];
  const attempts = { rows: [] as Array<{ status: string }>, updated: [] as Where[] };
  const prisma = {
    run: {
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<RunRow> }) => {
        let count = 0;
        for (const row of rows) {
          if (!matches(row, where)) continue;
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      }),
      findMany: vi.fn(async ({ where }: { where: Where }) =>
        rows.filter((row) => matches(row, where)),
      ),
      findUnique: vi.fn(
        async ({ where }: { where: Where }) => rows.find((row) => matches(row, where)) ?? null,
      ),
      findFirst: vi.fn(
        async ({ where }: { where: Where }) =>
          rows
            .filter((row) => matches(row, where))
            .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))[0] ??
          null,
      ),
    },
    attempt: {
      // Conta como o Prisma conta: só os attempts que casam com o filtro pedido.
      count: vi.fn(async ({ where }: { where: { status?: string } }) =>
        attempts.rows.filter((row) => !where.status || row.status === where.status).length,
      ),
      updateMany: vi.fn(async ({ where }: { where: Where }) => {
        attempts.updated.push(where);
        return { count: 1 };
      }),
    },
    task: { update: vi.fn(async () => undefined) },
    event: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        id: "e1",
        createdAt: new Date(),
      })),
    },
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (arg: unknown) =>
      typeof arg === "function"
        ? (arg as (tx: unknown) => Promise<unknown>)(prisma)
        : Promise.all(arg as Promise<unknown>[]),
    ),
  };
  const wakeup = {
    describe: () => ({
      id: "fake",
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
  return {
    rows,
    enqueued,
    attempts,
    wakeup,
    prisma: prisma as unknown as PrismaClient,
    raw: prisma,
  };
}

function queuedRun(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: "run-1",
    status: "queued",
    leaseOwner: null,
    leaseFence: 0,
    leaseExpiresAt: null,
    taskId: "task-1",
    workspaceId: "w",
    threadId: "t",
    botId: "b",
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("run lease acquisition", () => {
  it("claims a queued run and bumps the fence", async () => {
    const store = runStore([queuedRun()]);
    const lease = await acquireRunLease(store.prisma, { runId: "run-1", workerId: "w1", fence: 0 });
    expect(lease?.fence).toBe(1);
    expect(store.rows[0]!).toMatchObject({ status: "leased", leaseOwner: "w1", leaseFence: 1 });
  });

  it("refuses a second continue while another worker still holds the lease", async () => {
    const store = runStore([queuedRun()]);
    const first = await acquireRunLease(store.prisma, { runId: "run-1", workerId: "w1", fence: 0 });
    store.rows[0]!.status = "running";
    // The stale reader still sees the fence it loaded before the first worker leased.
    const second = await acquireRunLease(store.prisma, {
      runId: "run-1",
      workerId: "w2",
      fence: 0,
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(store.rows[0]!.leaseOwner).toBe("w1");
  });

  it("refuses a running run whose lease is still alive", async () => {
    const store = runStore([
      queuedRun({
        status: "running",
        leaseOwner: "w1",
        leaseFence: 3,
        leaseExpiresAt: new Date(Date.now() + RUN_LEASE_MS),
      }),
    ]);
    expect(
      await acquireRunLease(store.prisma, { runId: "run-1", workerId: "w2", fence: 3 }),
    ).toBeNull();
  });

  it("takes over a running run whose lease expired", async () => {
    const store = runStore([
      queuedRun({
        status: "running",
        leaseOwner: "dead",
        leaseFence: 3,
        leaseExpiresAt: new Date(Date.now() - 1),
      }),
    ]);
    const lease = await acquireRunLease(store.prisma, { runId: "run-1", workerId: "w2", fence: 3 });
    expect(lease?.fence).toBe(4);
    expect(store.rows[0]!.leaseOwner).toBe("w2");
  });
});

describe("run lease renewal", () => {
  it("extends the lease of the owner and refuses anyone else", async () => {
    const store = runStore([
      queuedRun({
        status: "running",
        leaseOwner: "w1",
        leaseFence: 1,
        leaseExpiresAt: new Date(0),
      }),
    ]);
    expect(await renewRunLease(store.prisma, { runId: "run-1", workerId: "w1", fence: 1 })).toBe(
      true,
    );
    expect(store.rows[0]!.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await renewRunLease(store.prisma, { runId: "run-1", workerId: "w2", fence: 1 })).toBe(
      false,
    );
  });

  it("stops renewing a cancelled run", async () => {
    const store = runStore([
      queuedRun({ status: "cancelled", leaseOwner: "w1", leaseFence: 1, leaseExpiresAt: null }),
    ]);
    expect(await renewRunLease(store.prisma, { runId: "run-1", workerId: "w1", fence: 1 })).toBe(
      false,
    );
  });
});

describe("run lease watcher", () => {
  it("renews on its own timer instead of once per streamed token", async () => {
    vi.useFakeTimers();
    const store = runStore([
      queuedRun({
        status: "running",
        leaseOwner: "w1",
        leaseFence: 1,
        leaseExpiresAt: new Date(0),
      }),
    ]);
    const watcher = watchRunLease(store.prisma, {
      runId: "run-1",
      workerId: "w1",
      fence: 1,
      intervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(3_100);
    expect(store.raw.run.updateMany).toHaveBeenCalledTimes(3);
    expect(watcher.lost()).toBeNull();
    watcher.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.raw.run.updateMany).toHaveBeenCalledTimes(3);
  });

  it("reports a cancel and a takeover by another worker", async () => {
    const cancelled = runStore([
      queuedRun({ status: "cancelled", leaseFence: 1, leaseOwner: "w1" }),
    ]);
    const lostCancel: string[] = [];
    const watcherA = watchRunLease(cancelled.prisma, {
      runId: "run-1",
      workerId: "w1",
      fence: 1,
      onLost: (reason) => lostCancel.push(reason),
    });
    expect(await watcherA.tick()).toBe("cancelled");
    expect(lostCancel).toEqual(["cancelled"]);
    watcherA.stop();

    const stolen = runStore([
      queuedRun({ status: "running", leaseFence: 2, leaseOwner: "w2", leaseExpiresAt: new Date() }),
    ]);
    const watcherB = watchRunLease(stolen.prisma, { runId: "run-1", workerId: "w1", fence: 1 });
    expect(await watcherB.tick()).toBe("stolen");
    expect(watcherB.lost()).toBe("stolen");
    watcherB.stop();
  });

  it("keeps the turn alive when the renewal query itself fails", async () => {
    const store = runStore([queuedRun({ status: "running", leaseFence: 1, leaseOwner: "w1" })]);
    store.raw.run.updateMany.mockRejectedValueOnce(new Error("connection reset"));
    const watcher = watchRunLease(store.prisma, { runId: "run-1", workerId: "w1", fence: 1 });
    expect(await watcher.tick()).toBeNull();
    watcher.stop();
  });
});

describe("expired lease reaper", () => {
  it("requeues an abandoned run and asks a worker to continue it", async () => {
    const store = runStore([
      queuedRun({
        status: "running",
        leaseOwner: "dead",
        leaseFence: 2,
        leaseExpiresAt: new Date(Date.now() - 60_000),
      }),
    ]);
    const result = await reapExpiredLeases({ prisma: store.prisma, wakeup: store.wakeup });
    expect(result.requeued).toEqual(["run-1"]);
    expect(store.rows[0]!).toMatchObject({
      status: "queued",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(store.enqueued).toEqual([{ name: "run.continue", payload: { runId: "run-1" } }]);
  });

  it("leaves a healthy lease alone", async () => {
    const store = runStore([
      queuedRun({
        status: "running",
        leaseOwner: "alive",
        leaseFence: 2,
        leaseExpiresAt: new Date(Date.now() + RUN_LEASE_MS),
      }),
    ]);
    const result = await reapExpiredLeases({ prisma: store.prisma, wakeup: store.wakeup });
    expect(result).toEqual({ requeued: [], failed: [] });
    expect(store.rows[0]!.status).toBe("running");
  });

  it("frees a pre-lease row that is stuck at running with no expiry", async () => {
    // Rows written before leases existed have `leaseExpiresAt: null`, so an expiry-only
    // query would leave them running forever.
    const store = runStore([
      queuedRun({
        status: "running",
        leaseOwner: "dead",
        leaseFence: 0,
        leaseExpiresAt: null,
        updatedAt: new Date(Date.now() - LEGACY_LEASE_GRACE_MS - 1),
      }),
    ]);
    const result = await reapExpiredLeases({ prisma: store.prisma, wakeup: store.wakeup });
    expect(result.requeued).toEqual(["run-1"]);
    expect(store.rows[0]!.status).toBe("queued");
  });

  it("waits out the grace period before touching a lease-less row", async () => {
    // During a rolling deploy the previous worker may still be executing such a row.
    const store = runStore([
      queuedRun({
        status: "running",
        leaseOwner: "old-worker",
        leaseFence: 0,
        leaseExpiresAt: null,
        updatedAt: new Date(Date.now() - 60_000),
      }),
    ]);
    const result = await reapExpiredLeases({ prisma: store.prisma, wakeup: store.wakeup });
    expect(result).toEqual({ requeued: [], failed: [] });
    expect(store.rows[0]!.status).toBe("running");
  });

  it("fails a run that already burned every attempt instead of looping", async () => {
    const store = runStore([
      queuedRun({
        status: "running",
        leaseOwner: "dead",
        leaseFence: 5,
        leaseExpiresAt: new Date(Date.now() - 1),
      }),
    ]);
    store.attempts.rows = [
      { status: "abandoned" },
      { status: "abandoned" },
      { status: "abandoned" },
    ];
    const result = await reapExpiredLeases({ prisma: store.prisma, wakeup: store.wakeup });
    expect(result.failed).toEqual(["run-1"]);
    expect(store.rows[0]!.status).toBe("failed");
    expect(store.enqueued).toEqual([]);
  });
});

describe("reaper scheduling", () => {
  it("uses one replaceable job key so workers do not pile up reapers", () => {
    const store = runStore([]);
    scheduleRunReap(store.wakeup, 0);
    expect(store.enqueued[0]).toMatchObject({ name: "run.reap", jobKey: "run.reap" });
  });
});

describe("one agent per bot", () => {
  it("only reports a sibling whose lease is alive", async () => {
    const alive = runStore([
      queuedRun({ id: "run-b" }),
      queuedRun({
        id: "run-a",
        status: "running",
        leaseExpiresAt: new Date(Date.now() + RUN_LEASE_MS),
      }),
    ]);
    expect(await botBusyWith(alive.prisma, { botId: "b", runId: "run-b" })).toBe("run-a");

    const dead = runStore([
      queuedRun({ id: "run-b" }),
      queuedRun({ id: "run-a", status: "running", leaseExpiresAt: new Date(Date.now() - 1) }),
    ]);
    expect(await botBusyWith(dead.prisma, { botId: "b", runId: "run-b" })).toBeNull();
  });

  it("ignores paused siblings, other bots and the run itself", async () => {
    const store = runStore([
      queuedRun({ id: "run-b" }),
      queuedRun({
        id: "run-paused",
        status: "waiting_input",
        leaseExpiresAt: new Date(Date.now() + RUN_LEASE_MS),
      }),
      queuedRun({
        id: "run-other",
        botId: "other",
        status: "running",
        leaseExpiresAt: new Date(Date.now() + RUN_LEASE_MS),
      }),
      queuedRun({
        id: "run-b-self",
        status: "running",
        leaseExpiresAt: new Date(Date.now() + RUN_LEASE_MS),
      }),
    ]);
    expect(await botBusyWith(store.prisma, { botId: "b", runId: "run-b-self" })).toBeNull();
  });

  it("parks the run under one retry key instead of losing it", async () => {
    const store = runStore([]);
    expect(await deferRunForBusyBot(store, { runId: "run-b" })).toBe(true);
    expect(store.enqueued[0]).toMatchObject({
      name: "run.continue",
      payload: { runId: "run-b" },
      jobKey: busyRetryJobKey("run-b"),
    });
    const runAt = store.enqueued[0]!.runAt as Date;
    expect(runAt.getTime()).toBeGreaterThan(Date.now() + BOT_BUSY_RETRY_MS - 1_000);
  });

  it("refuses to park a run when there is no driver to wake it again", async () => {
    expect(await deferRunForBusyBot({}, { runId: "run-b" })).toBe(false);
  });

  it("wakes the oldest queued run of the bot in FIFO order", async () => {
    const store = runStore([
      queuedRun({ id: "run-new", createdAt: new Date("2026-08-15T12:30:00.000Z") }),
      queuedRun({ id: "run-old", createdAt: new Date("2026-08-15T12:00:00.000Z") }),
      queuedRun({ id: "run-done", status: "completed" }),
      queuedRun({ id: "run-other-bot", botId: "other" }),
    ]);
    expect(await wakeNextRunForBot(store, { botId: "b", exceptRunId: "run-finished" })).toBe(
      "run-old",
    );
    expect(store.enqueued).toEqual([{ name: "run.continue", payload: { runId: "run-old" } }]);
  });

  it("skips the run that just finished and returns null when nothing is queued", async () => {
    const store = runStore([queuedRun({ id: "run-a" })]);
    expect(await wakeNextRunForBot(store, { botId: "b", exceptRunId: "run-a" })).toBeNull();
    expect(store.enqueued).toEqual([]);
  });
});

describe("requeue after a provider error", () => {
  it("puts the run back in the queue once and marks the attempt as retried", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));
    const store = runStore([
      queuedRun({ status: "running", leaseOwner: "worker-1", leaseFence: 3 }),
    ]);
    const requeued = await requeueRunAfterProviderError(
      { prisma: store.prisma, wakeup: store.wakeup },
      { runId: "run-1", fence: 3, reason: PROVIDER_STALLED_MESSAGE },
    );
    expect(requeued).toBe(true);
    expect(store.rows[0]!).toMatchObject({
      status: "queued",
      leaseOwner: null,
      leaseExpiresAt: null,
      leaseFence: 3,
    });
    expect(store.attempts.updated).toEqual([{ runId: "run-1", fence: 3, status: "running" }]);
    expect(store.enqueued).toEqual([
      {
        name: "run.continue",
        payload: { runId: "run-1" },
        runAt: new Date(Date.now() + PROVIDER_RETRY_DELAY_MS),
        jobKey: busyRetryJobKey("run-1"),
      },
    ]);
  });

  it("does not retry a second time: the failure reaches the chat instead", async () => {
    const store = runStore([
      queuedRun({ status: "running", leaseOwner: "worker-1", leaseFence: 4 }),
    ]);
    store.attempts.rows = [{ status: "retried" }];
    const requeued = await requeueRunAfterProviderError(
      { prisma: store.prisma, wakeup: store.wakeup },
      { runId: "run-1", fence: 4, reason: "429" },
    );
    expect(requeued).toBe(false);
    expect(store.rows[0]!.status).toBe("running");
    expect(store.enqueued).toEqual([]);
  });

  it("counts only spent retries: an attempt still running does not block the first one", async () => {
    const store = runStore([
      queuedRun({ status: "running", leaseOwner: "worker-1", leaseFence: 3 }),
    ]);
    // O attempt deste turno está "running", e cada retomada depois de uma aprovação abre
    // mais um: contar todos zeraria a única tentativa que o run tem direito.
    store.attempts.rows = [{ status: "running" }, { status: "completed" }];
    expect(
      await requeueRunAfterProviderError(
        { prisma: store.prisma, wakeup: store.wakeup },
        { runId: "run-1", fence: 3, reason: "502" },
      ),
    ).toBe(true);
    expect(store.rows[0]!.status).toBe("queued");
  });

  it("does not touch a run another worker already took over", async () => {
    const store = runStore([
      queuedRun({ status: "running", leaseOwner: "worker-2", leaseFence: 9 }),
    ]);
    const requeued = await requeueRunAfterProviderError(
      { prisma: store.prisma, wakeup: store.wakeup },
      { runId: "run-1", fence: 8, reason: "502" },
    );
    expect(requeued).toBe(false);
    expect(store.rows[0]!).toMatchObject({ status: "running", leaseOwner: "worker-2" });
    expect(store.attempts.updated).toEqual([]);
  });

  it("cannot requeue without a wakeup driver", async () => {
    const store = runStore([queuedRun({ status: "running", leaseFence: 1 })]);
    expect(
      await requeueRunAfterProviderError(
        { prisma: store.prisma },
        { runId: "run-1", fence: 1, reason: "x" },
      ),
    ).toBe(false);
  });
});
