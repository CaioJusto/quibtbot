import type { WakeupJob } from "@quibt/adapter-kit";
import {
  acquireRunLease,
  botBusyWith,
  RUN_LEASE_MS,
  RUN_MAX_ATTEMPTS,
  reapExpiredLeases,
} from "@quibt/adapters";
import { createDb } from "@quibt/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const hasDb = Boolean(process.env.DATABASE_URL);
const describeLease = hasDb ? describe : describe.skip;

/**
 * The unit tests for the lease run against a hand-written Prisma fake, and a fake cannot
 * prove a compare-and-swap: the guarantee lives in Postgres row locking. These exercise the
 * same functions against a real database, which is what the worker actually races on.
 */
describeLease("run leases against Postgres", () => {
  let db: ReturnType<typeof createDb>;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const workspaceId = `ws-lease-${stamp}`;
  const userId = `user-lease-${stamp}`;
  let threadId: string;
  let bots = 0;

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    await db.prisma.organization.create({
      data: {
        id: workspaceId,
        name: "Lease workspace",
        slug: `lease-${stamp}`,
        createdAt: new Date(),
      },
    });
    const thread = await db.prisma.thread.create({
      data: { workspaceId, userId, botId: (await newBot()).id },
    });
    threadId = thread.id;
  });

  afterAll(async () => {
    await db.prisma.organization.delete({ where: { id: workspaceId } }).catch(() => undefined);
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  /** Each test gets its own bot: `botBusyWith` looks at every run of the bot, so a lease
   * left behind by an earlier test would otherwise answer for the current one. */
  async function newBot() {
    bots += 1;
    return db.prisma.bot.create({
      data: { workspaceId, userId, name: `Leased ${bots}`, color: "#123456" },
    });
  }

  async function newRun(overrides: {
    status?: string;
    leaseOwner?: string | null;
    leaseExpiresAt?: Date | null;
    botId: string;
  }) {
    const task = await db.prisma.task.create({
      data: {
        workspaceId,
        botId: overrides.botId,
        threadId,
        userId,
        prompt: "lease",
        status: "queued",
      },
    });
    return db.prisma.run.create({
      data: {
        workspaceId,
        botId: overrides.botId,
        threadId,
        taskId: task.id,
        userId,
        status: overrides.status ?? "queued",
        trigger: "user",
        leaseOwner: overrides.leaseOwner ?? null,
        leaseExpiresAt: overrides.leaseExpiresAt ?? null,
      },
    });
  }

  it("eight workers race for the same run and exactly one wins", async () => {
    const run = await newRun({ botId: (await newBot()).id });
    const winners = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        acquireRunLease(db.prisma, {
          runId: run.id,
          workerId: `worker-${index}`,
          fence: run.leaseFence,
        }).then((lease) => (lease ? { index, lease } : null)),
      ),
    );
    const held = winners.filter((entry) => entry !== null);
    expect(held).toHaveLength(1);
    const row = await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe("leased");
    expect(row.leaseOwner).toBe(`worker-${held[0]!.index}`);
    expect(row.leaseFence).toBe(run.leaseFence + 1);
    expect(held[0]!.lease.fence).toBe(row.leaseFence);
  });

  it("a live lease cannot be stolen and an expired one can", async () => {
    const run = await newRun({ botId: (await newBot()).id });
    const first = await acquireRunLease(db.prisma, {
      runId: run.id,
      workerId: "worker-a",
      fence: run.leaseFence,
    });
    expect(first).not.toBeNull();

    const live = await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(
      await acquireRunLease(db.prisma, {
        runId: run.id,
        workerId: "worker-b",
        fence: live.leaseFence,
      }),
    ).toBeNull();

    // A worker that read the row before the first claim is refused.
    expect(
      await acquireRunLease(db.prisma, {
        runId: run.id,
        workerId: "worker-c",
        fence: run.leaseFence,
      }),
    ).toBeNull();

    await db.prisma.run.update({
      where: { id: run.id },
      data: { leaseExpiresAt: new Date(Date.now() - RUN_LEASE_MS) },
    });
    const stolen = await acquireRunLease(db.prisma, {
      runId: run.id,
      workerId: "worker-b",
      fence: live.leaseFence,
    });
    expect(stolen).not.toBeNull();
    const after = await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.leaseOwner).toBe("worker-b");
    expect(after.leaseFence).toBe(live.leaseFence + 1);
  });

  it("a stale claim is refused after the turn it wanted to run already happened", async () => {
    const run = await newRun({ botId: (await newBot()).id });
    const leased = await acquireRunLease(db.prisma, {
      runId: run.id,
      workerId: "worker-a",
      fence: run.leaseFence,
    });
    expect(leased).not.toBeNull();
    // A second worker reads the row while the lease is alive and only gets to act later.
    const stale = await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    // Meanwhile the turn finishes and parks the run waiting for the user: the status is
    // claimable again, so only the fence tells the late worker its view is out of date.
    await db.prisma.run.update({
      where: { id: run.id },
      data: { status: "waiting_input", leaseExpiresAt: null, leaseFence: stale.leaseFence + 1 },
    });

    expect(
      await acquireRunLease(db.prisma, {
        runId: run.id,
        workerId: "worker-b",
        fence: stale.leaseFence,
      }),
    ).toBeNull();
    expect((await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
      "waiting_input",
    );
  });

  it("two runs of the same bot serialize, and a run never blocks itself", async () => {
    const botId = (await newBot()).id;
    const otherBotId = (await newBot()).id;
    const first = await newRun({ botId });
    const second = await newRun({ botId });
    const foreign = await newRun({ botId: otherBotId });
    await acquireRunLease(db.prisma, {
      runId: first.id,
      workerId: "worker-a",
      fence: first.leaseFence,
    });

    expect(await botBusyWith(db.prisma, { botId, runId: second.id })).toBe(first.id);
    expect(await botBusyWith(db.prisma, { botId, runId: first.id })).toBeNull();
    expect(await botBusyWith(db.prisma, { botId: otherBotId, runId: foreign.id })).toBeNull();

    await db.prisma.run.update({
      where: { id: first.id },
      data: { leaseExpiresAt: new Date(Date.now() - RUN_LEASE_MS) },
    });
    expect(await botBusyWith(db.prisma, { botId, runId: second.id })).toBeNull();
  });

  it("the reaper requeues an abandoned run and fails it after the last attempt", async () => {
    const botId = (await newBot()).id;
    const abandoned = await newRun({
      botId,
      status: "running",
      leaseOwner: "dead-worker",
      leaseExpiresAt: new Date(Date.now() - RUN_LEASE_MS),
    });
    const live = await newRun({
      botId,
      status: "running",
      leaseOwner: "healthy-worker",
      leaseExpiresAt: new Date(Date.now() + RUN_LEASE_MS),
    });
    await db.prisma.attempt.create({
      data: { runId: abandoned.id, fence: abandoned.leaseFence, status: "running" },
    });
    const jobs: WakeupJob[] = [];
    const wakeup = { enqueue: async (job: WakeupJob) => void jobs.push(job) };

    const first = await reapExpiredLeases({
      prisma: db.prisma,
      wakeup: wakeup as never,
    });
    expect(first.requeued).toContain(abandoned.id);
    expect(first.requeued).not.toContain(live.id);
    expect(first.failed).toEqual([]);
    const requeued = await db.prisma.run.findUniqueOrThrow({ where: { id: abandoned.id } });
    expect(requeued.status).toBe("queued");
    expect(requeued.leaseOwner).toBeNull();
    expect(requeued.leaseExpiresAt).toBeNull();
    expect(jobs.map((job) => job.payload.runId)).toContain(abandoned.id);
    expect(await db.prisma.attempt.findFirst({ where: { runId: abandoned.id } })).toMatchObject({
      status: "abandoned",
    });
    expect((await db.prisma.run.findUniqueOrThrow({ where: { id: live.id } })).status).toBe(
      "running",
    );

    // Every attempt burned: the run fails instead of looping through the queue forever.
    await db.prisma.run.update({
      where: { id: abandoned.id },
      data: {
        status: "running",
        leaseOwner: "dead-worker",
        leaseExpiresAt: new Date(Date.now() - RUN_LEASE_MS),
      },
    });
    for (let i = 1; i < RUN_MAX_ATTEMPTS; i += 1) {
      await db.prisma.attempt.create({
        data: { runId: abandoned.id, fence: abandoned.leaseFence, status: "abandoned" },
      });
    }
    const second = await reapExpiredLeases({ prisma: db.prisma, wakeup: wakeup as never });
    expect(second.failed).toContain(abandoned.id);
    expect((await db.prisma.run.findUniqueOrThrow({ where: { id: abandoned.id } })).status).toBe(
      "failed",
    );
    expect(
      await db.prisma.event.findFirst({ where: { runId: abandoned.id, type: "run.failed" } }),
    ).not.toBeNull();
  });

  it("does not fail a run whose earlier attempts were pauses, not abandonments", async () => {
    const botId = (await newBot()).id;
    const run = await newRun({
      botId,
      status: "running",
      leaseOwner: "dead-worker",
      leaseExpiresAt: new Date(Date.now() - RUN_LEASE_MS),
    });
    // An approval, a teammate answer and a takeover each resume the run and open a new
    // attempt: three rows, none of them an abandonment.
    for (let fence = 0; fence <= 2; fence += 1) {
      await db.prisma.attempt.create({ data: { runId: run.id, fence, status: "running" } });
    }
    await db.prisma.run.update({ where: { id: run.id }, data: { leaseFence: 2 } });
    const jobs: WakeupJob[] = [];
    const wakeup = { enqueue: async (job: WakeupJob) => void jobs.push(job) };

    const reaped = await reapExpiredLeases({ prisma: db.prisma, wakeup: wakeup as never });
    expect(reaped.failed).not.toContain(run.id);
    expect(reaped.requeued).toContain(run.id);
    expect((await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
      "queued",
    );
    expect(await db.prisma.attempt.count({ where: { runId: run.id, status: "abandoned" } })).toBe(
      1,
    );
  });
});
