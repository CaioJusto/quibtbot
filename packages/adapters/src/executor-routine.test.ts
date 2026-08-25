import type { WakeupJob } from "@quibt/adapter-kit";
import type { PrismaClient } from "@quibt/db";
import { describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";

interface Sink {
  tasks: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
  routineUpdates: Array<Record<string, unknown>>;
}

function emptySink(): Sink {
  return { tasks: [], runs: [], routineUpdates: [] };
}

function routineHarness(options?: {
  failReschedule?: boolean;
  groupMembers?: string[];
  missingBot?: boolean;
  missingThread?: boolean;
}) {
  const committed = emptySink();
  const enqueued: WakeupJob[] = [];
  let created = 0;
  const writer = (sink: Sink) => ({
    task: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: `task-${sink.tasks.length + 1}` };
        sink.tasks.push(row);
        return row;
      },
    },
    run: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created += 1;
        const row = { ...data, id: `run-${created}` };
        sink.runs.push(row);
        return row;
      },
    },
    routine: {
      update: async ({ data }: { data: Record<string, unknown> }) => {
        if (options?.failReschedule) throw new Error("deadlock detected");
        sink.routineUpdates.push(data);
        return data;
      },
    },
  });
  const prisma = {
    routine: {
      findUnique: vi.fn(async () => ({
        id: "routine-1",
        active: true,
        cron: "*/5 * * * *",
        timezone: "UTC",
        workspaceId: "w",
        userId: "u",
        botId: options?.groupMembers ? null : "bot-1",
        groupId: options?.groupMembers ? "group-1" : null,
        prompt: "bom dia",
      })),
      update: writer(committed).routine.update,
    },
    bot: {
      findUnique: vi.fn(async () => {
        if (options?.missingBot) return null;
        return {
          id: "bot-1",
          thread: options?.missingThread ? null : { id: "thread-1" },
        };
      }),
    },
    botGroup: {
      findFirst: vi.fn(async () => ({
        id: "group-1",
        thread: { id: "thread-1" },
        members: (options?.groupMembers ?? []).map((botId) => ({ botId })),
      })),
    },
    $executeRaw: vi.fn(async () => 0),
    task: writer(committed).task,
    run: writer(committed).run,
    // Only what the callback writes survives, and only when it returns.
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      const staged = emptySink();
      const result = await cb(writer(staged));
      committed.tasks.push(...staged.tasks);
      committed.runs.push(...staged.runs);
      committed.routineUpdates.push(...staged.routineUpdates);
      return result;
    }),
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
    runtime: {} as never,
    sandbox: {} as never,
    memory: {} as never,
    home: {} as never,
    secrets: [],
    wakeup,
  });
  const continueRun = vi.fn(async () => undefined);
  executor.continueRun = continueRun;
  return { executor, committed, enqueued, continueRun };
}

describe("wakeRoutine", () => {
  it("creates the task, the run and the next schedule in one transaction", async () => {
    const { executor, committed, enqueued, continueRun } = routineHarness();
    await executor.wakeRoutine("routine-1", "worker-1");
    expect(committed.tasks).toHaveLength(1);
    expect(committed.runs).toHaveLength(1);
    expect(committed.routineUpdates).toHaveLength(1);
    expect(enqueued).toEqual([
      expect.objectContaining({ name: "routine.wakeup", jobKey: "routine:routine-1" }),
    ]);
    expect(continueRun).toHaveBeenCalledWith("run-1", "worker-1");
  });

  it("leaves no orphan run behind when the reschedule fails mid-way", async () => {
    const { executor, committed, enqueued, continueRun } = routineHarness({ failReschedule: true });
    await expect(executor.wakeRoutine("routine-1", "worker-1")).rejects.toThrow("deadlock");
    // A Graphile retry must not find a run from the failed attempt and create a second one.
    expect(committed.runs).toEqual([]);
    expect(committed.tasks).toEqual([]);
    expect(enqueued).toEqual([]);
    expect(continueRun).not.toHaveBeenCalled();
  });
});

describe("wakeRoutine without a target", () => {
  it("retires a routine whose bot is gone instead of leaving it scheduled forever", async () => {
    const { executor, committed, enqueued, continueRun } = routineHarness({ missingBot: true });
    await executor.wakeRoutine("routine-1", "worker-1");
    expect(committed.runs).toEqual([]);
    expect(committed.routineUpdates).toEqual([{ active: false, nextRunAt: null }]);
    expect(enqueued).toEqual([]);
    expect(continueRun).not.toHaveBeenCalled();
  });

  it("retires a routine whose thread is gone", async () => {
    const { executor, committed, continueRun } = routineHarness({ missingThread: true });
    await executor.wakeRoutine("routine-1", "worker-1");
    expect(committed.runs).toEqual([]);
    expect(committed.routineUpdates).toEqual([{ active: false, nextRunAt: null }]);
    expect(continueRun).not.toHaveBeenCalled();
  });
});

describe("wakeRoutine for a group", () => {
  it("creates every member run and the next schedule in one transaction", async () => {
    const { executor, committed, enqueued, continueRun } = routineHarness({
      groupMembers: ["bot-1", "bot-2"],
    });
    await executor.wakeRoutine("routine-1", "worker-1");
    expect(committed.runs).toHaveLength(2);
    expect(committed.routineUpdates).toHaveLength(1);
    expect(enqueued).toEqual([
      expect.objectContaining({ name: "routine.wakeup", jobKey: "routine:routine-1" }),
    ]);
    expect(continueRun).toHaveBeenCalledTimes(2);
  });

  it("leaves no orphan member run behind when the reschedule fails mid-way", async () => {
    const { executor, committed, enqueued, continueRun } = routineHarness({
      groupMembers: ["bot-1", "bot-2"],
      failReschedule: true,
    });
    await expect(executor.wakeRoutine("routine-1", "worker-1")).rejects.toThrow("deadlock");
    // Without the shared transaction the runs were already committed and the Graphile retry
    // woke the whole group a second time.
    expect(committed.runs).toEqual([]);
    expect(committed.tasks).toEqual([]);
    expect(enqueued).toEqual([]);
    expect(continueRun).not.toHaveBeenCalled();
  });
});
