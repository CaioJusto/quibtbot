import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { createGroupWakes, createPeerWake } from "./collaboration.js";

const actor = {
  userId: "user-1",
  workspaceId: "ws-1",
  workspaceRole: "owner" as const,
  email: "owner@example.com",
  isDeploymentOwner: true,
};

function groupHarness(options?: { existingRuns?: Array<{ id: string; clientNonce: string }> }) {
  const created: Array<{ id: string; clientNonce?: string }> = [];
  const events: unknown[] = [];
  let seq = 0;
  const existing = options?.existingRuns ?? [];
  const groupTouches: unknown[] = [];
  const prisma = {
    botGroup: {
      findFirst: vi.fn(async () => ({
        id: "group-1",
        thread: { id: "thread-1" },
        members: [
          { botId: "bot-1", bot: { name: "Ada" } },
          { botId: "bot-2", bot: { name: "Scout" } },
        ],
      })),
      updateMany: vi.fn(async (args: unknown) => {
        groupTouches.push(args);
        return { count: 1 };
      }),
    },
    run: {
      findMany: vi.fn(async () => (created.length ? created : existing)),
      create: vi.fn(async ({ data }: { data: { clientNonce?: string } }) => {
        if (existing.length && data.clientNonce) {
          const err = Object.assign(new Error("Unique constraint failed"), {
            code: "P2002",
            meta: { modelName: "Run", target: ["workspaceId", "clientNonce"] },
          });
          throw err;
        }
        const row = { id: `run-${created.length + 1}`, clientNonce: data.clientNonce };
        created.push(row);
        return row;
      }),
    },
    task: {
      create: vi.fn(async () => ({ id: `task-${created.length + 1}` })),
    },
    message: {
      findFirst: vi.fn(async () => (existing.length ? { seq: 7 } : { seq: seq - 1 })),
      create: vi.fn(async () => {
        const row = { id: `msg-${seq}`, seq };
        seq += 1;
        return row;
      }),
    },
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(prisma)),
    event: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `evt-${events.length + 1}`, createdAt: new Date(), ...data };
        events.push(row);
        return row;
      }),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, created, events, groupTouches };
}

describe("createGroupWakes", () => {
  it("creates one run per mentioned member and records the user message", async () => {
    const { prisma, created, events, groupTouches } = groupHarness();
    const result = await createGroupWakes(prisma, actor, {
      groupId: "group-1",
      text: "olá @Ada",
      clientNonce: "nonce-1",
    });
    expect(result.duplicate).toBe(false);
    expect(result.seq).toBe(0);
    expect(created).toHaveLength(1);
    expect(events).toHaveLength(1);
    // A lista ordena por `updatedAt`: cada recado novo tem que mover o grupo para cima.
    expect(groupTouches).toHaveLength(1);
  });

  it("returns the existing runs without creating another message on a retry", async () => {
    const { prisma, created, events } = groupHarness({
      existingRuns: [{ id: "run-old", clientNonce: "nonce-1:bot-1" }],
    });
    const result = await createGroupWakes(prisma, actor, {
      groupId: "group-1",
      text: "olá de novo",
      clientNonce: "nonce-1",
    });
    expect(result.duplicate).toBe(true);
    expect(result.seq).toBe(7);
    expect(result.runs.map((run) => run.id)).toEqual(["run-old"]);
    expect(created).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});

function peerHarness() {
  const runs: Array<{ id: string; trigger: string; webhookId: string | null }> = [];
  const events: unknown[] = [];
  let seq = 0;
  const prisma = {
    bot: {
      findMany: vi.fn(async () => [
        { id: "bot-1", name: "Ada", activeConversationId: null, thread: { id: "thread-1" } },
        { id: "bot-2", name: "Scout", activeConversationId: null, thread: { id: "thread-2" } },
      ]),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
    },
    botGroup: {
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    conversation: {
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
    },
    message: {
      findFirst: vi.fn(async () => ({ seq: seq - 1 })),
      create: vi.fn(async () => {
        const row = { id: `msg-${seq}`, seq };
        seq += 1;
        return row;
      }),
    },
    task: {
      create: vi.fn(async () => ({ id: `task-${runs.length + 1}` })),
    },
    run: {
      create: vi.fn(async ({ data }: { data: { trigger: string; webhookId?: string | null } }) => {
        const row = {
          id: `run-${runs.length + 1}`,
          trigger: data.trigger,
          webhookId: data.webhookId ?? null,
        };
        runs.push(row);
        return row;
      }),
    },
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(prisma)),
    event: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `evt-${events.length + 1}`, createdAt: new Date(), ...data };
        events.push(row);
        return row;
      }),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, runs };
}

describe("createPeerWake", () => {
  it("gives the peer run the ordinary peer trigger and no webhookId for a normal teammate hop", async () => {
    const { prisma, runs } = peerHarness();
    const result = await createPeerWake(prisma, actor, {
      fromBotId: "bot-1",
      toBotId: "bot-2",
      text: "e ai?",
    });
    expect(result.run.trigger).toBe("peer");
    expect(result.run.webhookId).toBeNull();
    expect(runs).toHaveLength(1);
  });

  it("keeps the peer run's own trigger as peer, but carries the webhook origin in webhookId", async () => {
    const { prisma, runs } = peerHarness();
    const result = await createPeerWake(prisma, actor, {
      fromBotId: "bot-1",
      toBotId: "bot-2",
      text: "e ai?",
      webhookId: "wh-1",
    });
    // The immediate cause is still an ordinary teammate hop: this is what lets the executor's
    // `run.trigger === "peer"` filter (which removes ask_bot to avoid an infinite loop) keep
    // applying to a webhook-descended peer run too.
    expect(result.run.trigger).toBe("peer");
    expect(result.run.webhookId).toBe("wh-1");
    expect(runs).toHaveLength(1);
  });

  it("refuses a bot messaging itself, regardless of webhook origin", async () => {
    const { prisma } = peerHarness();
    await expect(
      createPeerWake(prisma, actor, { fromBotId: "bot-1", toBotId: "bot-1", text: "oi" }),
    ).rejects.toThrow();
  });
});
