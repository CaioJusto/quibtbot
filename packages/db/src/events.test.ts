import { EventEmitter } from "node:events";
import type { Pool, PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  createThreadNotifier,
  EVENT_PAGE_SIZE,
  eventsAfter,
  followThreadEvents,
} from "./events.js";

class FakeClient extends EventEmitter {
  queries: string[] = [];
  released: Array<Error | undefined> = [];
  query = vi.fn(async (sql: string) => {
    this.queries.push(sql);
    return { rows: [] };
  });
  release = vi.fn((error?: Error) => {
    this.released.push(error);
  });
}

function fakePool() {
  const clients: FakeClient[] = [];
  const pool = {
    connect: vi.fn(async () => {
      const client = new FakeClient();
      clients.push(client);
      return client as unknown as PoolClient;
    }),
  } as unknown as Pool;
  return { pool, clients };
}

function notify(client: FakeClient, threadId: string) {
  client.emit("notification", {
    channel: "quibt_events",
    payload: JSON.stringify({ threadId, seq: 1 }),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createThreadNotifier", () => {
  it("retries LISTEN after acquiring the shared connection fails", async () => {
    const client = new FakeClient();
    const pool = {
      connect: vi
        .fn()
        .mockRejectedValueOnce(new Error("pool busy"))
        .mockResolvedValueOnce(client as unknown as PoolClient),
    } as unknown as Pool;
    const notifier = createThreadNotifier(pool);
    await expect(notifier.ready()).rejects.toThrow("pool busy");
    await notifier.ready();
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(client.queries).toEqual(["LISTEN quibt_events"]);
    await notifier.close();
  });

  it("shares one LISTEN client across subscribers and wakes only the matching thread", async () => {
    const { pool, clients } = fakePool();
    const notifier = createThreadNotifier(pool);
    const a = notifier.wait("thread-a", 60_000);
    const b = notifier.wait("thread-b", 60_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(clients[0]?.queries).toEqual(["LISTEN quibt_events"]);

    let aDone = false;
    let bDone = false;
    void a.promise.then(() => {
      aDone = true;
    });
    void b.promise.then(() => {
      bDone = true;
    });
    notify(clients[0]!, "thread-a");
    await Promise.resolve();
    expect(aDone).toBe(true);
    expect(bDone).toBe(false);
    b.cancel();
    await notifier.close();
    expect(clients[0]?.released).toHaveLength(1);
  });

  it("wakes waiters and reconnects when the LISTEN connection drops", async () => {
    const { pool, clients } = fakePool();
    const notifier = createThreadNotifier(pool);
    const first = notifier.wait("thread-a", 60_000);
    await Promise.resolve();
    await Promise.resolve();
    clients[0]!.emit("error", new Error("connection terminated"));
    await first.promise;
    expect(clients[0]?.released[0]).toBeInstanceOf(Error);

    const second = notifier.wait("thread-a", 60_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(pool.connect).toHaveBeenCalledTimes(2);
    notify(clients[1]!, "thread-a");
    await second.promise;
    await notifier.close();
  });

  it("times out and aborts without leaking waiters", async () => {
    vi.useFakeTimers();
    const { pool } = fakePool();
    const notifier = createThreadNotifier(pool);
    const timed = notifier.wait("t", 1000);
    let done = false;
    void timed.promise.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);

    const abort = new AbortController();
    const aborted = notifier.wait("t", 60_000, abort.signal);
    abort.abort();
    await aborted.promise;
    await notifier.close();
  });
});

describe("eventsAfter", () => {
  it("pages from the cursor and can take the newest window instead", async () => {
    const rows = Array.from({ length: 6 }, (_, seq) => ({ id: `e${seq}`, seq }));
    const findMany = vi.fn(
      async ({
        where,
        orderBy,
        take,
      }: {
        where: { seq: { gt: number } };
        orderBy: { seq: "asc" | "desc" };
        take: number;
      }) => {
        const matched = rows.filter((row) => row.seq > where.seq.gt);
        const ordered = orderBy.seq === "desc" ? [...matched].reverse() : matched;
        return ordered.slice(0, take);
      },
    );
    const prisma = { event: { findMany } } as unknown as PrismaClient;
    await expect(eventsAfter(prisma, "t", 1, { limit: 2 })).resolves.toEqual([
      { id: "e2", seq: 2 },
      { id: "e3", seq: 3 },
    ]);
    await expect(eventsAfter(prisma, "t", -1, { limit: 2, newest: true })).resolves.toEqual([
      { id: "e4", seq: 4 },
      { id: "e5", seq: 5 },
    ]);
    expect(EVENT_PAGE_SIZE).toBe(500);
  });
});

describe("followThreadEvents", () => {
  it("activates LISTEN before its first event query", async () => {
    let releaseListen: () => void = () => undefined;
    const listening = new Promise<void>((resolve) => {
      releaseListen = resolve;
    });
    const client = new FakeClient();
    client.query = vi.fn(async () => {
      await listening;
      return { rows: [] };
    });
    const pool = {
      connect: vi.fn(async () => client as unknown as PoolClient),
    } as unknown as Pool;
    const findMany = vi.fn(async () => [
      { id: "e1", threadId: "t", seq: 0, type: "run.started", payload: {} },
    ]);
    const prisma = { event: { findMany } } as unknown as PrismaClient;
    const notifier = createThreadNotifier(pool);
    const abort = new AbortController();
    const next = followThreadEvents(prisma, "t", -1, notifier, abort.signal).next();

    await Promise.resolve();
    expect(findMany).not.toHaveBeenCalled();
    releaseListen();
    await expect(next).resolves.toMatchObject({ value: { seq: 0 }, done: false });
    expect(findMany).toHaveBeenCalledOnce();
    abort.abort();
    await notifier.close();
  });

  it("drains new events on notify and stops when the subscriber aborts", async () => {
    const rows = [
      { id: "e1", threadId: "t", seq: 0, type: "run.started", payload: {} },
      { id: "e2", threadId: "t", seq: 1, type: "thread.progress", payload: {} },
    ];
    const findMany = vi.fn(async ({ where }: { where: { seq: { gt: number } } }) =>
      rows.filter((row) => row.seq > where.seq.gt),
    );
    const prisma = { event: { findMany } } as unknown as PrismaClient;
    const { pool, clients } = fakePool();
    const notifier = createThreadNotifier(pool);
    const abort = new AbortController();
    const seen: number[] = [];

    const consumer = (async () => {
      for await (const event of followThreadEvents(prisma, "t", -1, notifier, abort.signal)) {
        seen.push(event.seq);
        if (event.seq === 2) abort.abort();
      }
    })();

    // Existing rows are replayed immediately, then the follower parks on the notifier.
    await vi.waitFor(() => expect(seen).toEqual([0, 1]));
    rows.push({ id: "e3", threadId: "t", seq: 2, type: "run.completed", payload: {} });
    await vi.waitFor(() => expect(clients[0]).toBeDefined());
    notify(clients[0]!, "t");
    await consumer;
    expect(seen).toEqual([0, 1, 2]);
    await notifier.close();
  });
});
