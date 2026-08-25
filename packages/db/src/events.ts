import type { ProductEvent } from "@quibt/contracts";
import { UNTITLED_TASK } from "@quibt/core";
import type { Notification, Pool, PoolClient } from "pg";
import type { Prisma, PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";

const ACTIVE_RUN_STATUSES = ["queued", "leased", "running", "waiting_input", "waiting_takeover"];

export interface ClearThreadInput {
  workspaceId: string;
  threadId: string;
  botId: string;
}

export interface ClearThreadResult {
  event: ProductEvent;
  cancelledRunIds: string[];
  conversationId: string;
}

export interface CancelThreadRunsResult {
  events: ProductEvent[];
  cancelledRunIds: string[];
}

type RunCancellation = { id: string; taskId: string };

async function cancelActiveRuns(
  tx: Prisma.TransactionClient,
  input: ClearThreadInput,
  now: Date,
): Promise<RunCancellation[]> {
  const activeRuns = await tx.run.findMany({
    where: {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      botId: input.botId,
      status: { in: ACTIVE_RUN_STATUSES },
    },
    select: { id: true, taskId: true },
  });
  const cancelled: RunCancellation[] = [];
  for (const run of activeRuns) {
    const changed = await tx.run.updateMany({
      where: { id: run.id, status: { in: ACTIVE_RUN_STATUSES } },
      data: {
        status: "cancelled",
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    if (changed.count === 1) cancelled.push(run);
  }
  const runIds = cancelled.map((run) => run.id);
  if (runIds.length === 0) return cancelled;
  await tx.attempt.updateMany({
    where: { runId: { in: runIds }, status: "running" },
    data: { status: "cancelled", finishedAt: now },
  });
  await tx.task.updateMany({
    where: { id: { in: cancelled.map((run) => run.taskId) } },
    data: { status: "cancelled" },
  });
  return cancelled;
}

/**
 * Stops every active turn for one bot and persists the terminal events in the same
 * transaction. The worker notices the cancelled lease and aborts the model/tool loop;
 * the events make desktop and mobile drop their stale “working” state immediately.
 */
export async function cancelThreadRuns(
  prisma: PrismaClient,
  input: ClearThreadInput,
): Promise<CancelThreadRunsResult> {
  const committed = await prisma.$transaction(async (tx) => {
    const thread = await tx.thread.findFirst({
      where: {
        id: input.threadId,
        workspaceId: input.workspaceId,
        botId: input.botId,
      },
      select: { id: true },
    });
    if (!thread) throw new IsolationError();
    const cancelled = await cancelActiveRuns(tx, input, new Date());
    if (cancelled.length === 0) return { events: [], cancelledRunIds: [] };

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.threadId}))`;
    const last = await tx.event.findFirst({
      where: { threadId: input.threadId },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    const events = [];
    let seq = last?.seq ?? -1;
    for (const run of cancelled) {
      seq += 1;
      events.push(
        await tx.event.create({
          data: {
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            botId: input.botId,
            seq,
            type: "run.cancelled",
            payload: {},
            runId: run.id,
          },
        }),
      );
    }
    return { events, cancelledRunIds: cancelled.map((run) => run.id) };
  });
  for (const event of committed.events) await notifyThreadEvent(prisma, event);
  return {
    events: committed.events.map(mapPersistedEvent),
    cancelledRunIds: committed.cancelledRunIds,
  };
}

export async function appendEvent(
  prisma: PrismaClient,
  input: {
    workspaceId: string;
    threadId: string;
    botId?: string;
    type: ProductEvent["type"];
    payload: Record<string, unknown>;
    runId?: string;
  },
): Promise<ProductEvent> {
  const event = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.threadId}))`;
    const last = await tx.event.findFirst({
      where: { threadId: input.threadId },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    const seq = (last?.seq ?? -1) + 1;
    return tx.event.create({
      data: {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        botId: input.botId,
        seq,
        type: input.type,
        payload: input.payload as Prisma.InputJsonValue,
        runId: input.runId,
      },
    });
  });
  await notifyThreadEvent(prisma, event);
  return mapPersistedEvent(event);
}

/**
 * Wipes the active conversation's messages and stops current work. The bot, computer,
 * memory, routines, files, and other conversations stay. Events stay so other
 * conversations can still reconstruct live progress from the shared thread log.
 */
export async function clearThread(
  prisma: PrismaClient,
  input: ClearThreadInput,
): Promise<ClearThreadResult> {
  const committed = await prisma.$transaction(async (tx) => {
    const thread = await tx.thread.findFirst({
      where: {
        id: input.threadId,
        workspaceId: input.workspaceId,
        botId: input.botId,
      },
      select: { id: true },
    });
    if (!thread) throw new IsolationError();

    const bot = await tx.bot.findFirst({
      where: { id: input.botId, workspaceId: input.workspaceId },
      select: { activeConversationId: true },
    });
    if (!bot) throw new IsolationError();

    let conversation = bot.activeConversationId
      ? await tx.conversation.findFirst({
          where: { id: bot.activeConversationId, botId: input.botId },
        })
      : null;
    if (!conversation) {
      conversation = await tx.conversation.findFirst({
        where: { botId: input.botId },
        orderBy: { createdAt: "asc" },
      });
    }
    if (!conversation) throw new IsolationError();

    const now = new Date();
    const cancelledRuns = await cancelActiveRuns(tx, input, now);
    const runIds = cancelledRuns.map((run) => run.id);

    await tx.message.deleteMany({
      where: {
        threadId: input.threadId,
        OR: [{ conversationId: conversation.id }, { conversationId: null }],
      },
    });
    await tx.conversation.update({
      where: { id: conversation.id },
      data: { activeLeafId: null, title: UNTITLED_TASK, updatedAt: now },
    });
    await tx.bot.update({
      where: { id: input.botId, workspaceId: input.workspaceId },
      data: { unread: false, updatedAt: now, activeConversationId: conversation.id },
    });

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.threadId}))`;
    const last = await tx.event.findFirst({
      where: { threadId: input.threadId },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    const event = await tx.event.create({
      data: {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        botId: input.botId,
        seq: (last?.seq ?? -1) + 1,
        type: "thread.cleared",
        payload: { conversationId: conversation.id } as Prisma.InputJsonValue,
      },
    });
    return { event, cancelledRunIds: runIds, conversationId: conversation.id };
  });
  await notifyThreadEvent(prisma, committed.event);
  return {
    event: mapPersistedEvent(committed.event),
    cancelledRunIds: committed.cancelledRunIds,
    conversationId: committed.conversationId,
  };
}

function mapPersistedEvent(event: {
  id: string;
  workspaceId: string;
  threadId: string;
  botId: string | null;
  seq: number;
  type: string;
  runId: string | null;
  createdAt: Date;
  payload: Prisma.JsonValue;
}): ProductEvent {
  return {
    id: event.id,
    workspaceId: event.workspaceId,
    threadId: event.threadId,
    botId: event.botId ?? undefined,
    seq: event.seq,
    type: event.type as ProductEvent["type"],
    runId: event.runId ?? undefined,
    createdAt: event.createdAt.toISOString(),
    payload: event.payload as Record<string, unknown>,
  };
}

async function notifyThreadEvent(
  prisma: PrismaClient,
  event: { workspaceId: string; threadId: string; botId: string | null; seq: number },
) {
  await prisma.$executeRaw`SELECT pg_notify('quibt_events', ${JSON.stringify({
    workspaceId: event.workspaceId,
    threadId: event.threadId,
    botId: event.botId ?? undefined,
    seq: event.seq,
  })})`;
}

/**
 * Streaming writes one cumulative `thread.progress` event per tick; once the run has a
 * durable message and a terminal event they only bloat every future thread load.
 */
/** Live streaming ticks. Subscribers see them via NOTIFY; they do not bloat the events table. */
export async function publishLiveProgress(
  prisma: PrismaClient,
  input: {
    workspaceId: string;
    threadId: string;
    botId?: string;
    runId?: string;
    payload: Record<string, unknown>;
  },
) {
  await prisma.$executeRaw`SELECT pg_notify('quibt_events', ${JSON.stringify({
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    botId: input.botId,
    runId: input.runId,
    type: "thread.progress",
    payload: input.payload,
  })})`;
}

export async function pruneProgressEvents(prisma: PrismaClient, runId: string) {
  await prisma.event.deleteMany({ where: { runId, type: "thread.progress" } });
}

/** Page size for incremental event reads. `followThreadEvents` loops until the page is short. */
export const EVENT_PAGE_SIZE = 500;

export async function eventsAfter(
  prisma: PrismaClient,
  threadId: string,
  cursor: number,
  options?: { limit?: number; newest?: boolean },
) {
  const limit = options?.limit ?? EVENT_PAGE_SIZE;
  const rows = await prisma.event.findMany({
    where: { threadId, seq: { gt: cursor } },
    orderBy: { seq: options?.newest ? "desc" : "asc" },
    take: limit,
  });
  return options?.newest ? rows.reverse() : rows;
}

type ProgressPayload = {
  threadId?: string;
  workspaceId?: string;
  botId?: string;
  runId?: string;
  type?: string;
  payload?: Record<string, unknown>;
};

type Waiter = { threadId: string; wake: (progress?: ProgressPayload) => void };

/**
 * One LISTEN connection per process, shared by every thread subscription. Holding a pool
 * client per subscriber used to exhaust the Prisma pool after a handful of open threads.
 */
export type ThreadNotifier = {
  /** Opens LISTEN before the first query, closing the query/subscribe race on a new stream. */
  ready(): Promise<void>;
  /** Resolves when the thread gets a new event, `ms` elapse, the signal aborts, or the LISTEN link drops. */
  wait(
    threadId: string,
    ms: number,
    signal?: AbortSignal,
  ): { promise: Promise<void>; cancel(): void };
  takeProgress?(threadId: string): ProgressPayload | undefined;
  close(): Promise<void>;
};

export function createThreadNotifier(pool: Pool): ThreadNotifier {
  const waiters = new Set<Waiter>();
  const progress = new Map<string, ProgressPayload>();
  let client: PoolClient | undefined;
  let connecting: Promise<void> | undefined;
  let closed = false;

  const wakeAll = () => {
    for (const waiter of [...waiters]) waiter.wake();
  };
  const dropClient = (error?: Error) => {
    const current = client;
    client = undefined;
    connecting = undefined;
    if (current) {
      current.removeAllListeners("notification");
      current.removeAllListeners("error");
      current.removeAllListeners("end");
      current.release(error);
    }
    // Subscribers re-query on wake, so nothing is lost while we reconnect lazily.
    wakeAll();
  };
  const ensureClient = () => {
    if (closed || client) return Promise.resolve();
    connecting ??= (async () => {
      const next = await pool.connect();
      try {
        await next.query("LISTEN quibt_events");
      } catch (error) {
        next.release(error as Error);
        connecting = undefined;
        throw error;
      }
      next.on("notification", (msg: Notification) => {
        if (msg.channel !== "quibt_events") return;
        try {
          const data = JSON.parse(msg.payload ?? "{}") as ProgressPayload;
          for (const waiter of [...waiters]) {
            if (waiter.threadId === data.threadId) {
              if (data.type === "thread.progress") progress.set(data.threadId, data);
              waiter.wake();
            }
          }
        } catch {
          // ignore malformed payloads
        }
      });
      const onLost = (error?: Error) => dropClient(error);
      next.on("error", onLost);
      next.on("end", () => onLost());
      client = next;
      connecting = undefined;
    })();
    // `pool.connect()` can fail before there is a client to release. Clear the rejected
    // promise too, otherwise every later wait would reuse it and LISTEN would never retry.
    void connecting.catch(() => {
      if (!client) connecting = undefined;
    });
    return connecting;
  };

  return {
    ready: ensureClient,
    wait(threadId, ms, signal) {
      let cancel: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        const waiter: Waiter = { threadId, wake: () => done() };
        const timer = setTimeout(done, ms);
        function done() {
          clearTimeout(timer);
          waiters.delete(waiter);
          signal?.removeEventListener("abort", done);
          resolve();
        }
        cancel = done;
        waiters.add(waiter);
        signal?.addEventListener("abort", done, { once: true });
        if (signal?.aborted) {
          done();
          return;
        }
        // A LISTEN failure just degrades to the timeout; the caller polls on that cadence.
        ensureClient().catch(() => undefined);
      });
      return { promise, cancel };
    },
    takeProgress(threadId) {
      const payload = progress.get(threadId);
      progress.delete(threadId);
      return payload;
    },
    async close() {
      closed = true;
      const current = client;
      client = undefined;
      if (current) {
        await current.query("UNLISTEN quibt_events").catch(() => undefined);
        current.removeAllListeners("notification");
        current.removeAllListeners("error");
        current.removeAllListeners("end");
        current.release();
      }
      wakeAll();
    },
  };
}

const notifiers = new WeakMap<Pool, ThreadNotifier>();

function notifierFor(source: Pool | ThreadNotifier | undefined): ThreadNotifier | undefined {
  if (!source) return undefined;
  if ("wait" in source && typeof source.wait === "function") return source;
  const pool = source as Pool;
  let notifier = notifiers.get(pool);
  if (!notifier) {
    notifier = createThreadNotifier(pool);
    notifiers.set(pool, notifier);
  }
  return notifier;
}

/** Releases the shared LISTEN client so `pool.end()` does not wait on it. */
export async function closeThreadNotifier(pool: Pool) {
  const notifier = notifiers.get(pool);
  notifiers.delete(pool);
  await notifier?.close();
}

export async function* followThreadEvents(
  prisma: PrismaClient,
  threadId: string,
  cursor: number,
  source?: Pool | ThreadNotifier,
  signal?: AbortSignal,
): AsyncGenerator<Awaited<ReturnType<typeof eventsAfter>>[number]> {
  let seq = cursor;
  const notifier = notifierFor(source);
  // If the first query happened before LISTEN completed, an event committed in that gap
  // could leave the stream parked until the timeout. Make the subscription active first.
  await notifier?.ready().catch(() => undefined);
  while (!signal?.aborted) {
    // Arm the wake-up before querying so a notify that lands mid-query is not missed.
    const wake = notifier ? notifier.wait(threadId, 2_500, signal) : undefined;
    const events = await eventsAfter(prisma, threadId, seq);
    for (const event of events) {
      seq = event.seq;
      yield event;
    }
    if (signal?.aborted) {
      wake?.cancel();
      break;
    }
    if (events.length > 0) {
      // Something already arrived; go straight back for more instead of sleeping.
      wake?.cancel();
      continue;
    }
    if (wake) await wake.promise;
    else await sleep(400, signal);
    const live = notifier?.takeProgress?.(threadId);
    if (live?.payload) {
      yield {
        id: `live-${live.runId ?? threadId}`,
        workspaceId: live.workspaceId ?? "",
        threadId,
        botId: live.botId ?? null,
        seq,
        type: "thread.progress",
        payload: live.payload as never,
        runId: live.runId ?? null,
        createdAt: new Date(),
      };
    }
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
