import type { WakeupDriver } from "@quibt/adapter-kit";
import type { PrismaClient } from "@quibt/db";
import { appendEvent } from "@quibt/db";

/** How long a worker owns a run before another worker may take it over. */
export const RUN_LEASE_MS = 60_000;
/**
 * Renewal cadence: dozens of chances to renew before the lease expires, and also how fast a
 * cancel is noticed now that the streaming loop no longer queries the run per token.
 */
export const RUN_LEASE_RENEW_MS = 2_000;
/** How often the reaper looks for runs whose worker stopped renewing. */
export const RUN_REAP_INTERVAL_MS = 30_000;
/** Attempts before a run that keeps being abandoned fails instead of being requeued. */
export const RUN_MAX_ATTEMPTS = 3;
/**
 * Rows written before leases were enforced sit at `running` with no `leaseExpiresAt`, so the
 * expiry query alone would never free them. They are only reaped once they are older than
 * Graphile's own 4h job lock, which is long enough that a worker still executing such a run
 * under the previous code has already lost the job anyway.
 */
export const LEGACY_LEASE_GRACE_MS = 4 * 60 * 60_000;

/** Statuses a fresh `run.continue` may claim without waiting for a lease to expire. */
const CLAIMABLE = ["queued", "waiting_input", "waiting_takeover"];
/** Statuses that mean another worker holds the run; only a dead lease can be stolen. */
const LEASED = ["leased", "running"];

export interface RunLease {
  fence: number;
  expiresAt: Date;
}

/** Why a turn has to stop before the runtime finishes. */
export type RunLeaseLoss = "cancelled" | "stolen" | "missing";

/**
 * Atomic lease acquisition: one `updateMany` that only matches when the run is idle or its
 * lease is dead, and only when the fence is still the one we read. Two `run.continue` jobs
 * for the same run therefore never execute the agent twice.
 */
export async function acquireRunLease(
  prisma: PrismaClient,
  input: {
    runId: string;
    workerId: string;
    fence: number;
    now?: Date;
    leaseMs?: number;
  },
): Promise<RunLease | null> {
  const now = input.now ?? new Date();
  const fence = input.fence + 1;
  const expiresAt = new Date(now.getTime() + (input.leaseMs ?? RUN_LEASE_MS));
  const claimed = await prisma.run.updateMany({
    where: {
      id: input.runId,
      leaseFence: input.fence,
      OR: [
        { status: { in: CLAIMABLE } },
        { status: { in: LEASED }, leaseExpiresAt: { lt: now } },
        { status: { in: LEASED }, leaseExpiresAt: null },
      ],
    },
    data: {
      status: "leased",
      leaseOwner: input.workerId,
      leaseFence: fence,
      leaseExpiresAt: expiresAt,
    },
  });
  if (claimed.count !== 1) return null;
  return { fence, expiresAt };
}

/** Extends the lease while a long run streams. False means we are not the owner any more. */
export async function renewRunLease(
  prisma: PrismaClient,
  input: {
    runId: string;
    workerId: string;
    fence: number;
    now?: Date;
    leaseMs?: number;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const renewed = await prisma.run.updateMany({
    where: {
      id: input.runId,
      leaseFence: input.fence,
      leaseOwner: input.workerId,
      status: { notIn: ["completed", "failed", "cancelled"] },
    },
    data: { leaseExpiresAt: new Date(now.getTime() + (input.leaseMs ?? RUN_LEASE_MS)) },
  });
  return renewed.count === 1;
}

/** Drops the lease so a requeued run can be picked up again without waiting for expiry. */
export async function releaseRunLease(
  prisma: PrismaClient,
  input: { runId: string; fence: number },
): Promise<void> {
  await prisma.run.updateMany({
    where: { id: input.runId, leaseFence: input.fence },
    data: { leaseOwner: null, leaseExpiresAt: null },
  });
}

export interface RunLeaseWatcher {
  /** One renew-and-check tick; exposed so tests do not depend on the interval. */
  tick(): Promise<RunLeaseLoss | null>;
  /** The loss seen so far, so the streaming loop can bail out without another query. */
  lost(): RunLeaseLoss | null;
  stop(): void;
}

/**
 * A single timer replaces both the per-token `run.findUnique` cancellation check and the
 * lease renewal: one `updateMany` per tick renews the lease, and a miss means the run was
 * cancelled, finished elsewhere or taken over by another worker.
 */
export function watchRunLease(
  prisma: PrismaClient,
  input: {
    runId: string;
    workerId: string;
    fence: number;
    intervalMs?: number;
    leaseMs?: number;
    onLost?: (reason: RunLeaseLoss) => void;
  },
): RunLeaseWatcher {
  let loss: RunLeaseLoss | null = null;
  let stopped = false;

  const tick = async (): Promise<RunLeaseLoss | null> => {
    if (stopped || loss) return loss;
    const held = await renewRunLease(prisma, {
      runId: input.runId,
      workerId: input.workerId,
      fence: input.fence,
      leaseMs: input.leaseMs,
    }).catch(() => true);
    if (held) return null;
    const current = await prisma.run
      .findUnique({
        where: { id: input.runId },
        select: { status: true, leaseFence: true },
      })
      .catch(() => null);
    // A different fence means another worker took over; same fence means the row is
    // already terminal (cancelled by the user, or failed elsewhere).
    const reason: RunLeaseLoss = !current
      ? "missing"
      : current.leaseFence === input.fence
        ? "cancelled"
        : "stolen";
    if (stopped || loss) return loss;
    loss = reason;
    input.onLost?.(reason);
    return reason;
  };

  const timer = setInterval(() => {
    void tick().catch(() => undefined);
  }, input.intervalMs ?? RUN_LEASE_RENEW_MS);
  timer.unref?.();

  return {
    tick,
    lost: () => loss,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * Runs whose worker died keep the `running` row forever (the Graphile lock only frees the
 * job after hours). The reaper puts them back in the queue, and fails the ones that already
 * burned every attempt instead of looping.
 */
export async function reapExpiredLeases(
  deps: { prisma: PrismaClient; wakeup?: WakeupDriver },
  options?: { now?: Date; limit?: number; maxAttempts?: number },
): Promise<{ requeued: string[]; failed: string[] }> {
  const now = options?.now ?? new Date();
  const maxAttempts = options?.maxAttempts ?? RUN_MAX_ATTEMPTS;
  const legacyCutoff = new Date(now.getTime() - LEGACY_LEASE_GRACE_MS);
  const expired = await deps.prisma.run.findMany({
    where: {
      status: { in: LEASED },
      OR: [
        { leaseExpiresAt: { lt: now } },
        { leaseExpiresAt: null, updatedAt: { lt: legacyCutoff } },
      ],
    },
    select: {
      id: true,
      taskId: true,
      workspaceId: true,
      threadId: true,
      botId: true,
      leaseFence: true,
    },
    orderBy: { leaseExpiresAt: "asc" },
    take: options?.limit ?? 50,
  });
  const requeued: string[] = [];
  const failed: string[] = [];
  for (const run of expired) {
    await deps.prisma.attempt
      .updateMany({
        where: { runId: run.id, fence: run.leaseFence, status: "running" },
        data: { status: "abandoned", finishedAt: now, error: "lease expired" },
      })
      .catch(() => undefined);
    // Only abandonments count. A run gets a fresh attempt row every time it legitimately
    // resumes (an approval, a teammate answer, a takeover), so counting every attempt failed
    // runs that had merely paused three times and then lost their worker once.
    const attempts = await deps.prisma.attempt.count({
      where: { runId: run.id, status: "abandoned" },
    });
    if (attempts >= maxAttempts) {
      const message = "O worker parou de responder e a tentativa foi abandonada.";
      const done = await deps.prisma.run.updateMany({
        where: { id: run.id, leaseFence: run.leaseFence, status: { in: LEASED } },
        data: { status: "failed", error: message, completedAt: now },
      });
      if (done.count !== 1) continue;
      await deps.prisma.task
        .update({ where: { id: run.taskId }, data: { status: "failed" } })
        .catch(() => undefined);
      await appendEvent(deps.prisma, {
        workspaceId: run.workspaceId,
        threadId: run.threadId,
        botId: run.botId,
        type: "run.failed",
        runId: run.id,
        payload: { error: message },
      }).catch(() => undefined);
      failed.push(run.id);
      continue;
    }
    const requeue = await deps.prisma.run.updateMany({
      where: { id: run.id, leaseFence: run.leaseFence, status: { in: LEASED } },
      data: { status: "queued", leaseOwner: null, leaseExpiresAt: null },
    });
    if (requeue.count !== 1) continue;
    await deps.wakeup
      ?.enqueue({ name: "run.continue", payload: { runId: run.id } })
      .catch((error) => console.error("run.continue", error));
    requeued.push(run.id);
  }
  return { requeued, failed };
}

/** How long a run parked behind a busy bot waits before trying again. */
export const BOT_BUSY_RETRY_MS = 5_000;

/** One retry job per parked run, so repeated deferrals do not pile up. */
export function busyRetryJobKey(runId: string): string {
  return `run.continue:${runId}`;
}

/**
 * One agent per bot: `threads.send` only cancels `queued` siblings, so a second message while
 * the bot is working creates a run that would otherwise stream into the same thread and drive
 * the same computer in parallel. Only a LIVE lease counts as busy — a dead one would let a
 * crashed worker lock the bot until the reaper arrives.
 */
export async function botBusyWith(
  prisma: PrismaClient,
  input: { botId: string; runId: string; now?: Date },
): Promise<string | null> {
  const now = input.now ?? new Date();
  const busy = await prisma.run.findFirst({
    where: {
      botId: input.botId,
      id: { not: input.runId },
      status: { in: LEASED },
      leaseExpiresAt: { gt: now },
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return busy?.id ?? null;
}

/**
 * Parks a run behind the bot's current turn. The row is left untouched (it is still `queued`,
 * or still waiting for its user) and only the wake is rescheduled: a run nobody wakes up is
 * worse than a run that executes twice.
 */
export async function deferRunForBusyBot(
  deps: { wakeup?: WakeupDriver },
  input: { runId: string; retryMs?: number },
): Promise<boolean> {
  if (!deps.wakeup) return false;
  await deps.wakeup
    .enqueue({
      name: "run.continue",
      payload: { runId: input.runId },
      runAt: new Date(Date.now() + (input.retryMs ?? BOT_BUSY_RETRY_MS)),
      jobKey: busyRetryJobKey(input.runId),
    })
    .catch((error) => console.error("run.continue", error));
  return true;
}

/** FIFO: when a turn ends, the bot's oldest queued run gets its chance right away. */
export async function wakeNextRunForBot(
  deps: { prisma: PrismaClient; wakeup?: WakeupDriver },
  input: { botId: string; exceptRunId?: string },
): Promise<string | null> {
  if (!deps.wakeup) return null;
  const next = await deps.prisma.run.findFirst({
    where: {
      botId: input.botId,
      status: "queued",
      ...(input.exceptRunId ? { id: { not: input.exceptRunId } } : {}),
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!next) return null;
  await deps.wakeup
    .enqueue({ name: "run.continue", payload: { runId: next.id } })
    .catch((error) => console.error("run.continue", error));
  return next.id;
}

/** Keeps the reaper running on the same self-rescheduling pattern as `computer.sleep`. */
export function scheduleRunReap(wakeup: WakeupDriver | undefined, delayMs?: number): void {
  if (!wakeup) return;
  void wakeup
    .enqueue({
      name: "run.reap",
      payload: {},
      runAt: new Date(Date.now() + (delayMs ?? RUN_REAP_INTERVAL_MS)),
      jobKey: "run.reap",
    })
    .catch((error) => console.error("run.reap", error));
}
