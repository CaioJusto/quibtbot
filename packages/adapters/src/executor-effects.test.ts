import { Prisma, type PrismaClient } from "@quibt/db";
import { describe, expect, it, vi } from "vitest";
import { type ExecutorDeps, recordEffect } from "./executor.js";

interface EffectRow {
  id: string;
  workspaceId: string;
  runId: string;
  kind: string;
  idempotencyKey: string;
  status: string;
  request: unknown;
  result: unknown;
}

function effectStore(rows: EffectRow[]) {
  const events: Array<Record<string, unknown>> = [];
  const prisma = {
    externalEffect: {
      findUnique: vi.fn(
        async ({ where }: { where: { idempotencyKey: string } }) =>
          rows.find((row) => row.idempotencyKey === where.idempotencyKey) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Partial<EffectRow> }) => {
        const row = { id: `eff-${rows.length + 1}`, result: null, ...data } as EffectRow;
        rows.push(row);
        return row;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<EffectRow> }) => {
          const row = rows.find((entry) => entry.id === where.id);
          if (!row) throw new Error("effect not found");
          Object.assign(row, data);
          return row;
        },
      ),
    },
    run: {
      findUniqueOrThrow: vi.fn(async () => ({ threadId: "thread-1", botId: "bot-1" })),
    },
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        $executeRaw: async () => 0,
        event: {
          findFirst: async () => null,
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const row = { id: `evt-${events.length + 1}`, createdAt: new Date(), ...data };
            events.push(row);
            return row;
          },
        },
      }),
    ),
    $executeRaw: vi.fn(async () => 0),
  };
  const deps = { prisma: prisma as unknown as PrismaClient } as unknown as ExecutorDeps;
  return { deps, prisma, rows, events };
}

const run = { id: "run-1", workspaceId: "ws-1" };

describe("recordEffect", () => {
  it("records a first-time effect as intended", async () => {
    const { deps, rows } = effectStore([]);
    const applied = await recordEffect(deps, run, "shell", "run-1:call-1", { command: "ls" });
    expect(applied.duplicate).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "intended", idempotencyKey: "run-1:call-1" });
  });

  it("replays a completed effect instead of running the tool twice", async () => {
    const { deps, rows, events } = effectStore([
      {
        id: "eff-1",
        workspaceId: "ws-1",
        runId: "run-1",
        kind: "shell",
        idempotencyKey: "run-1:call-1",
        status: "completed",
        request: { command: "ls" },
        result: { stdout: "ok" },
      },
    ]);
    const applied = await recordEffect(deps, run, "shell", "run-1:call-1", { command: "ls" });
    expect(applied.duplicate).toBe(true);
    expect(applied.effect.result).toEqual({ stdout: "ok" });
    expect(rows).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it.each(["intended", "failed"])(
    "runs the tool again when the previous attempt was %s",
    async (status) => {
      const { deps, rows, events } = effectStore([
        {
          id: "eff-1",
          workspaceId: "ws-1",
          runId: "run-0",
          kind: "shell",
          idempotencyKey: "run-1:call-1",
          status,
          request: { command: "ls" },
          result: status === "failed" ? { error: "boom" } : null,
        },
      ]);
      const applied = await recordEffect(deps, run, "shell", "run-1:call-1", { command: "ls" });
      // The tool never returned, so reporting it as already applied would tell the model
      // (and the user) that work happened when nothing did.
      expect(applied.duplicate).toBe(false);
      expect(applied.effect.id).toBe("eff-1");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "intended", runId: "run-1" });
      // The stale result is cleared, not carried into the new attempt.
      expect(rows[0]?.result).toBe(Prisma.DbNull);
      expect(events).toEqual([]);
    },
  );
});
