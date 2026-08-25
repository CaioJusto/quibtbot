import { UNTITLED_TASK } from "@quibt/core";
import { describe, expect, it, vi } from "vitest";
import { cancelThreadRuns, clearThread } from "./events.js";
import { IsolationError } from "./scope.js";

describe("clearThread", () => {
  it("cancels active work and deletes only the active conversation messages", async () => {
    const now = new Date("2026-08-16T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const tx = {
      thread: { findFirst: vi.fn().mockResolvedValue({ id: "thread-1" }) },
      bot: {
        findFirst: vi.fn().mockResolvedValue({ activeConversationId: "convo-1" }),
        update: vi.fn(),
      },
      conversation: {
        findFirst: vi.fn().mockResolvedValue({ id: "convo-1", botId: "bot-1" }),
        update: vi.fn(),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([{ id: "run-1", taskId: "task-1" }]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
      message: { deleteMany: vi.fn() },
      event: {
        findFirst: vi.fn().mockResolvedValue({ seq: 4 }),
        create: vi.fn().mockResolvedValue({
          id: "evt-5",
          workspaceId: "ws-1",
          threadId: "thread-1",
          botId: "bot-1",
          seq: 5,
          type: "thread.cleared",
          runId: null,
          createdAt: now,
          payload: { conversationId: "convo-1" },
        }),
      },
      $executeRaw: vi.fn(),
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
      $executeRaw: vi.fn(),
    };

    const result = await clearThread(prisma as never, {
      workspaceId: "ws-1",
      threadId: "thread-1",
      botId: "bot-1",
    });

    expect(tx.message.deleteMany).toHaveBeenCalledWith({
      where: {
        threadId: "thread-1",
        OR: [{ conversationId: "convo-1" }, { conversationId: null }],
      },
    });
    expect(tx.run.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-1",
        status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
      },
      data: {
        status: "cancelled",
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    expect(tx.conversation.update).toHaveBeenCalledWith({
      where: { id: "convo-1" },
      data: { activeLeafId: null, title: UNTITLED_TASK, updatedAt: now },
    });
    expect(result).toMatchObject({
      cancelledRunIds: ["run-1"],
      conversationId: "convo-1",
      event: { type: "thread.cleared", seq: 5 },
    });
    expect(prisma.$executeRaw).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("refuses when the thread is not in the workspace", async () => {
    const tx = {
      thread: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    await expect(
      clearThread(prisma as never, {
        workspaceId: "ws-1",
        threadId: "missing",
        botId: "bot-1",
      }),
    ).rejects.toBeInstanceOf(IsolationError);
  });
});

describe("cancelThreadRuns", () => {
  it("closes runs, attempts and tasks and publishes one terminal event per run", async () => {
    const now = new Date("2026-08-20T23:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const tx = {
      thread: { findFirst: vi.fn().mockResolvedValue({ id: "thread-1" }) },
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "run-1", taskId: "task-1" },
          { id: "run-2", taskId: "task-2" },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
      event: {
        findFirst: vi.fn().mockResolvedValue({ seq: 8 }),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: `evt-${data.seq}`,
          ...data,
          createdAt: now,
        })),
      },
      $executeRaw: vi.fn(),
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
      $executeRaw: vi.fn(),
    };

    const result = await cancelThreadRuns(prisma as never, {
      workspaceId: "ws-1",
      threadId: "thread-1",
      botId: "bot-1",
    });

    expect(result.cancelledRunIds).toEqual(["run-1", "run-2"]);
    expect(result.events).toMatchObject([
      { type: "run.cancelled", runId: "run-1", seq: 9 },
      { type: "run.cancelled", runId: "run-2", seq: 10 },
    ]);
    expect(tx.attempt.updateMany).toHaveBeenCalledWith({
      where: { runId: { in: ["run-1", "run-2"] }, status: "running" },
      data: { status: "cancelled", finishedAt: now },
    });
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["task-1", "task-2"] } },
      data: { status: "cancelled" },
    });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
