import { QUEUED_RUN_PATIENCE_MS, WORKER_DOWN_MESSAGE, WORKER_GONE_MS } from "@quibt/core";
import type { PrismaClient } from "@quibt/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  failRunsWithoutWorker,
  lastWorkerSeenAt,
  recordWorkerHeartbeat,
  startWorkerHeartbeat,
} from "./worker-heartbeat.js";

const now = new Date("2026-08-25T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

interface HeartbeatRow {
  id: string;
  version: string;
  startedAt: Date;
  seenAt: Date;
}

interface RunRow {
  id: string;
  status: string;
  botId: string;
  taskId: string;
  workspaceId: string;
  threadId: string;
  leaseFence: number;
  updatedAt: Date;
  error?: string | null;
  completedAt?: Date | null;
}

type Where = Record<string, unknown>;

/** O bastante do casador do Prisma para os filtros que o reconciliador usa. */
function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") {
      const branches = condition as Where[];
      return branches.some((branch) => matches(row, branch));
    }
    const value = row[key];
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      const filter = condition as Record<string, unknown>;
      if ("lt" in filter) {
        if (!(value instanceof Date)) return false;
        return value.getTime() < (filter.lt as Date).getTime();
      }
      if ("in" in filter) return (filter.in as unknown[]).includes(value);
      throw new Error(`filtro sem suporte ${JSON.stringify(filter)}`);
    }
    return value === condition;
  });
}

function store(input: { heartbeats?: HeartbeatRow[]; runs?: RunRow[] } = {}) {
  const heartbeats = input.heartbeats ?? [];
  const runs = input.runs ?? [];
  const tasks: Array<Record<string, unknown>> = [];
  const messages: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const prisma = {
    workerHeartbeat: {
      upsert: vi.fn(
        async (args: {
          where: { id: string };
          create: HeartbeatRow;
          update: Partial<HeartbeatRow>;
        }) => {
          const existing = heartbeats.find((row) => row.id === args.where.id);
          if (existing) {
            Object.assign(existing, args.update);
            return existing;
          }
          heartbeats.push({ ...args.create });
          return args.create;
        },
      ),
      deleteMany: vi.fn(async ({ where }: { where: Where }) => {
        let count = 0;
        for (let i = heartbeats.length - 1; i >= 0; i -= 1) {
          if (!matches(heartbeats[i] as unknown as Record<string, unknown>, where)) continue;
          heartbeats.splice(i, 1);
          count += 1;
        }
        return { count };
      }),
      findFirst: vi.fn(async () => {
        const newest = [...heartbeats].sort((a, b) => b.seenAt.getTime() - a.seenAt.getTime())[0];
        return newest ? { seenAt: newest.seenAt } : null;
      }),
    },
    run: {
      findMany: vi.fn(async ({ where }: { where: Where }) =>
        runs.filter((row) => matches(row as unknown as Record<string, unknown>, where)),
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<RunRow> }) => {
        let count = 0;
        for (const row of runs) {
          if (!matches(row as unknown as Record<string, unknown>, where)) continue;
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      }),
    },
    task: {
      update: vi.fn(async (args: Record<string, unknown>) => {
        tasks.push(args);
        return {};
      }),
    },
    attempt: {
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    bot: {
      findUnique: vi.fn(async () => ({
        name: "Quib",
        notifyOnFinish: false,
        activeConversationId: null,
      })),
    },
    conversation: {
      findUnique: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
    },
    message: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        messages.push(data);
        return { ...data, id: `m${messages.length}` };
      }),
    },
    event: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return { ...data, id: `e${events.length}`, seq: events.length, createdAt: now };
      }),
    },
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (arg: unknown) => (arg as (tx: unknown) => Promise<unknown>)(prisma)),
  };
  return { prisma: prisma as unknown as PrismaClient, heartbeats, runs, tasks, events, messages };
}

function queuedRun(patch: Partial<RunRow> = {}): RunRow {
  return {
    id: "run-1",
    status: "queued",
    botId: "bot-1",
    taskId: "task-1",
    workspaceId: "ws-1",
    threadId: "thr-1",
    leaseFence: 0,
    updatedAt: ago(QUEUED_RUN_PATIENCE_MS + 1_000),
    ...patch,
  };
}

describe("recordWorkerHeartbeat", () => {
  it("cria a linha na primeira vez e só avança seenAt depois", async () => {
    const s = store();
    await recordWorkerHeartbeat(s.prisma, {
      workerId: "host:1",
      version: "0.2.11",
      now: ago(30_000),
    });
    await recordWorkerHeartbeat(s.prisma, { workerId: "host:1", version: "0.2.11", now });
    expect(s.heartbeats).toHaveLength(1);
    expect(s.heartbeats[0]?.startedAt).toEqual(ago(30_000));
    expect(s.heartbeats[0]?.seenAt).toEqual(now);
  });

  it("varre workers sumidos há mais de uma hora", async () => {
    const s = store({
      heartbeats: [
        {
          id: "velho",
          version: "0.2.10",
          startedAt: ago(3 * 3_600_000),
          seenAt: ago(2 * 3_600_000),
        },
        { id: "recente", version: "0.2.11", startedAt: ago(600_000), seenAt: ago(120_000) },
      ],
    });
    await recordWorkerHeartbeat(s.prisma, { workerId: "host:2", version: "0.2.11", now });
    expect(s.heartbeats.map((row) => row.id).sort()).toEqual(["host:2", "recente"]);
  });
});

describe("lastWorkerSeenAt", () => {
  it("é nulo sem worker e o mais recente com vários", async () => {
    expect(await lastWorkerSeenAt(store().prisma)).toBeNull();
    const s = store({
      heartbeats: [
        { id: "a", version: "x", startedAt: now, seenAt: ago(50_000) },
        { id: "b", version: "x", startedAt: now, seenAt: ago(5_000) },
      ],
    });
    expect(await lastWorkerSeenAt(s.prisma)).toEqual(ago(5_000));
  });
});

describe("startWorkerHeartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("bate já, bate de novo no intervalo, e para quando mandam", async () => {
    vi.useFakeTimers();
    const s = store();
    const loop = startWorkerHeartbeat(s.prisma, {
      workerId: "host:9",
      version: "dev",
      intervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.heartbeats).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_500);
    const upsert = (
      s.prisma as unknown as { workerHeartbeat: { upsert: ReturnType<typeof vi.fn> } }
    ).workerHeartbeat.upsert;
    expect(upsert).toHaveBeenCalledTimes(3);
    loop.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(upsert).toHaveBeenCalledTimes(3);
  });

  it("um banco fora do ar vai para onError e não derruba o laço", async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const prisma = {
      workerHeartbeat: {
        upsert: vi.fn(async () => {
          throw new Error("banco caiu");
        }),
      },
    } as unknown as PrismaClient;
    const loop = startWorkerHeartbeat(prisma, {
      workerId: "host:3",
      version: "dev",
      intervalMs: 1_000,
      onError: (error) => errors.push(error),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(errors).toHaveLength(2);
    loop.stop();
  });
});

describe("failRunsWithoutWorker", () => {
  it("um run recém-enfileirado fica em paz, mesmo sem worker", async () => {
    const s = store({ runs: [queuedRun({ updatedAt: ago(30_000) })] });
    expect(await failRunsWithoutWorker({ prisma: s.prisma }, { now })).toEqual([]);
    expect(s.runs[0]?.status).toBe("queued");
  });

  it("um run na fila há mais de 2 min com worker vivo continua esperando", async () => {
    const s = store({
      runs: [queuedRun()],
      heartbeats: [{ id: "w", version: "x", startedAt: now, seenAt: ago(WORKER_GONE_MS) }],
    });
    expect(await failRunsWithoutWorker({ prisma: s.prisma }, { now })).toEqual([]);
    expect(s.runs[0]?.status).toBe("queued");
    expect(s.events).toHaveLength(0);
  });

  it("sem worker há mais de 90 s, o run vira failed com a frase que diz o que fazer", async () => {
    const s = store({
      runs: [queuedRun()],
      heartbeats: [{ id: "w", version: "x", startedAt: now, seenAt: ago(WORKER_GONE_MS + 1) }],
    });
    expect(await failRunsWithoutWorker({ prisma: s.prisma }, { now })).toEqual(["run-1"]);
    expect(s.runs[0]).toMatchObject({
      status: "failed",
      error: WORKER_DOWN_MESSAGE,
      completedAt: now,
    });
    expect(s.tasks).toEqual([{ where: { id: "task-1" }, data: { status: "failed" } }]);
    expect(s.messages).toEqual([
      expect.objectContaining({
        threadId: "thr-1",
        role: "system",
        blocks: [{ kind: "text", text: WORKER_DOWN_MESSAGE }],
      }),
    ]);
    expect(s.events.map((event) => event.type)).toEqual(["thread.message.created", "run.failed"]);
    expect(s.events).toContainEqual(
      expect.objectContaining({
        type: "run.failed",
        runId: "run-1",
        threadId: "thr-1",
        botId: "bot-1",
        payload: { error: WORKER_DOWN_MESSAGE },
      }),
    );
  });

  it("nunca houve worker: a fila inteira do bot pedido vira erro, a dos outros fica", async () => {
    const s = store({
      runs: [
        queuedRun({ id: "run-a", botId: "bot-1" }),
        queuedRun({ id: "run-b", botId: "bot-2", threadId: "thr-2" }),
        queuedRun({ id: "run-c", botId: "bot-1", status: "running" }),
      ],
    });
    expect(await failRunsWithoutWorker({ prisma: s.prisma }, { now, botId: "bot-1" })).toEqual([
      "run-a",
    ]);
    expect(s.runs.map((row) => row.status)).toEqual(["failed", "queued", "running"]);
  });

  it("sem run parado, nem pergunta pelo batimento", async () => {
    const s = store();
    const workerSeenAt = vi.fn(async () => null);
    expect(await failRunsWithoutWorker({ prisma: s.prisma, workerSeenAt }, { now })).toEqual([]);
    expect(workerSeenAt).not.toHaveBeenCalled();
  });

  it("um run que outro processo pegou no meio do caminho não é reprovado", async () => {
    const s = store({ runs: [queuedRun()] });
    const prisma = s.prisma as unknown as { run: { findMany: ReturnType<typeof vi.fn> } };
    prisma.run.findMany.mockImplementationOnce(async () => {
      const snapshot = [{ ...(s.runs[0] as RunRow) }];
      (s.runs[0] as RunRow).status = "leased";
      return snapshot;
    });
    expect(await failRunsWithoutWorker({ prisma: s.prisma }, { now })).toEqual([]);
    expect(s.runs[0]?.status).toBe("leased");
    expect(s.events).toHaveLength(0);
  });
});
