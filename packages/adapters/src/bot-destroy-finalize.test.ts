import type { AgentHomeStore } from "@quibt/adapter-kit";
import type { PrismaClient } from "@quibt/db";
import { describe, expect, it } from "vitest";
import {
  DESTROY_BATCH_SIZE,
  finalizeBotDestroyAfterProvider,
  purgeBotHistoryInBatches,
} from "./bot-destroy-finalize.js";

type Trace = string[];

/**
 * Um banco de mentira com duas tabelas filhas de verdade (runs e tasks) e um diário de
 * chamadas, para ver a ordem: o histórico pesado tem de sair ANTES da transação final.
 */
function fakePrisma(options: {
  runs?: number;
  tasks?: number;
  finalized?: boolean;
  trace?: Trace;
  removeCount?: (ids: string[]) => number;
  /** Índice (1-based) do lote de runs que estoura, como um banco caindo no meio. */
  failRunBatch?: number;
  failFinalTx?: boolean;
}) {
  const trace = options.trace ?? [];
  const rows = {
    run: Array.from({ length: options.runs ?? 0 }, (_, i) => `run-${i}`),
    task: Array.from({ length: options.tasks ?? 0 }, (_, i) => `task-${i}`),
  };
  // A linha da sessão de verdade: é ela que segura a marca de exclusão e o providerRef
  // de que a intent pendente depende para poder ser retomada.
  const session = {
    state: "deleting",
    bootClaimToken: options.finalized === false ? "someone-else" : "token-1",
    bootClaimedAt: new Date(0),
    providerRef: "box-1",
    deleted: false,
  };
  const controls = {
    failRunBatch: options.failRunBatch ?? 0,
    failFinalTx: options.failFinalTx ?? false,
  };
  let runBatch = 0;
  const table = (name: "run" | "task") => ({
    findMany: async ({ take }: { take: number }) => {
      trace.push(`${name}.findMany:${take}`);
      return rows[name].slice(0, take).map((id) => ({ id }));
    },
    deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
      const ids = where.id.in;
      if (name === "run") {
        runBatch += 1;
        if (controls.failRunBatch === runBatch) {
          trace.push("run.deleteMany:boom");
          throw new Error("batch failed");
        }
      }
      trace.push(`${name}.deleteMany:${ids.length}`);
      const count = options.removeCount ? options.removeCount(ids) : ids.length;
      rows[name] = rows[name].filter((id) => !ids.slice(0, count).includes(id));
      return { count };
    },
  });
  const matchesSession = (where: Record<string, unknown>) => {
    if (session.deleted) return false;
    if (typeof where.state === "string" && where.state !== session.state) return false;
    if (where.bootClaimToken !== undefined && where.bootClaimToken !== session.bootClaimToken) {
      return false;
    }
    return true;
  };
  const prisma = {
    run: table("run"),
    task: table("task"),
    desktopSession: {
      findUnique: async () => (session.deleted ? null : { ...session }),
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (!matchesSession(where)) return { count: 0 };
        if (data.bootClaimedAt instanceof Date) trace.push("desktopSession.renew");
        Object.assign(session, data);
        return { count: 1 };
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        trace.push("tx.desktopSession.deleteMany");
        if (!matchesSession(where)) return { count: 0 };
        session.deleted = true;
        return { count: 1 };
      },
      count: async () => 0,
    },
    bot: {
      delete: async () => {
        trace.push("tx.bot.delete");
        if (controls.failFinalTx) throw new Error("final tx failed");
        return {};
      },
    },
    computer: { delete: async () => ({}) },
    computerUsage: { updateMany: async () => ({ count: 0 }), findMany: async () => [] },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      trace.push("tx.begin");
      const snapshot = { ...session };
      try {
        const out = await fn(prisma);
        trace.push("tx.end");
        return out;
      } catch (error) {
        // Uma transação que estoura desfaz tudo, inclusive a remoção cercada da sessão.
        Object.assign(session, snapshot);
        trace.push("tx.rollback");
        throw error;
      }
    },
  } as unknown as PrismaClient;
  return { prisma, trace, rows, session, controls };
}

const home = {} as AgentHomeStore;

describe("purgeBotHistoryInBatches", () => {
  it("empties runs and tasks in batches instead of one giant statement", async () => {
    const { prisma, trace } = fakePrisma({ runs: 1_200, tasks: 700 });
    const removed = await purgeBotHistoryInBatches(prisma, "bot-1", 500);
    expect(removed).toBe(1_900);
    expect(trace.filter((line) => line.startsWith("run.deleteMany"))).toEqual([
      "run.deleteMany:500",
      "run.deleteMany:500",
      "run.deleteMany:200",
    ]);
    expect(trace.filter((line) => line.startsWith("task.deleteMany"))).toEqual([
      "task.deleteMany:500",
      "task.deleteMany:200",
    ]);
    // Runs primeiro: a task é dona da run e não sai antes dela.
    expect(trace.indexOf("run.deleteMany:500")).toBeLessThan(trace.indexOf("task.deleteMany:500"));
  });

  it("does nothing when the bot has no history", async () => {
    const { prisma, trace } = fakePrisma({});
    expect(await purgeBotHistoryInBatches(prisma, "bot-1")).toBe(0);
    expect(trace.filter((line) => line.includes("deleteMany"))).toEqual([]);
  });

  it("gives up instead of spinning forever when a batch deletes nothing", async () => {
    const { prisma } = fakePrisma({ runs: 10, removeCount: () => 0 });
    expect(await purgeBotHistoryInBatches(prisma, "bot-1", 5)).toBe(0);
  });

  it("uses a batch size that keeps each statement short", () => {
    expect(DESTROY_BATCH_SIZE).toBeGreaterThan(0);
    expect(DESTROY_BATCH_SIZE).toBeLessThanOrEqual(1_000);
  });

  it("refuses an invalid batch size instead of looping forever", async () => {
    const { prisma } = fakePrisma({ runs: 1 });
    await expect(purgeBotHistoryInBatches(prisma, "bot-1", 0)).rejects.toThrow(/batch size/);
  });
});

describe("finalizeBotDestroyAfterProvider", () => {
  const input = {
    botId: "bot-1",
    workspaceId: "ws-1",
    claimToken: "token-1",
    restoreState: "running",
    computer: null,
    dataDir: "./data",
  };

  it("clears the heavy history before the closing transaction", async () => {
    const { prisma, trace } = fakePrisma({ runs: 600, tasks: 10 });
    expect(await finalizeBotDestroyAfterProvider({ prisma, home }, input)).toBe(true);
    const firstDelete = trace.findIndex((line) => line.startsWith("run.deleteMany"));
    const begin = trace.indexOf("tx.begin");
    expect(firstDelete).toBeGreaterThanOrEqual(0);
    expect(firstDelete).toBeLessThan(begin);
    // A transação que fecha só toca em duas linhas.
    expect(trace.slice(begin)).toEqual([
      "tx.begin",
      "tx.desktopSession.deleteMany",
      "tx.bot.delete",
      "tx.end",
    ]);
  });

  // O bot continua vivo quando a marca de exclusão não é nossa: seu histórico não pode sumir.
  it("touches no history when the delete claim is not ours", async () => {
    const { prisma, trace } = fakePrisma({ runs: 600, finalized: false });
    expect(await finalizeBotDestroyAfterProvider({ prisma, home }, input)).toBe(false);
    expect(trace).toEqual([]);
  });

  it("keeps the deleting claim alive while the history leaves in batches", async () => {
    const { prisma, session, trace } = fakePrisma({ runs: 600, tasks: 1 });
    session.bootClaimedAt = new Date(0);
    expect(await finalizeBotDestroyAfterProvider({ prisma, home }, input)).toBe(true);
    // A primeira renovação é atômica com a validação e vem antes de tocar no histórico.
    expect(trace.indexOf("desktopSession.renew")).toBeLessThan(trace.indexOf("run.findMany:500"));
    // Renovada a cada lote: um expurgo longo não pode ser roubado por
    // recoverStaleDesktopDelete no meio do caminho.
    expect(session.bootClaimedAt.getTime()).toBeGreaterThan(0);
  });

  // Retomada 1: o banco cai depois de lotes já apagados.
  it("resumes after a failed history batch and finishes on retry", async () => {
    const { prisma, rows, session, controls } = fakePrisma({
      runs: 1_200,
      tasks: 3,
      failRunBatch: 2,
    });
    await expect(finalizeBotDestroyAfterProvider({ prisma, home }, input)).rejects.toThrow(
      "batch failed",
    );
    // Meio apagado, mas ainda retomável: o primeiro lote saiu e a marca continua de pé.
    expect(rows.run).toHaveLength(700);
    expect(session.deleted).toBe(false);
    expect(session.state).toBe("deleting");
    expect(session.bootClaimToken).toBe("token-1");
    // O providerRef é a foto que a intent pendente compara; perdê-lo tornaria o retry "stale".
    expect(session.providerRef).toBe("box-1");

    controls.failRunBatch = 0;
    expect(await finalizeBotDestroyAfterProvider({ prisma, home }, input)).toBe(true);
    expect(rows.run).toEqual([]);
    expect(rows.task).toEqual([]);
    expect(session.deleted).toBe(true);
  });

  // Retomada 2: a transação final estoura depois do expurgo.
  it("resumes after the closing transaction fails and finishes on retry", async () => {
    const { prisma, rows, session, controls } = fakePrisma({
      runs: 600,
      tasks: 3,
      failFinalTx: true,
    });
    await expect(finalizeBotDestroyAfterProvider({ prisma, home }, input)).rejects.toThrow(
      "final tx failed",
    );
    expect(rows.run).toEqual([]);
    expect(session.deleted).toBe(false);
    expect(session.state).toBe("deleting");
    expect(session.bootClaimToken).toBe("token-1");

    controls.failFinalTx = false;
    expect(await finalizeBotDestroyAfterProvider({ prisma, home }, input)).toBe(true);
    expect(session.deleted).toBe(true);
  });

  it("stops the purge when another worker stole the claim mid-purge", async () => {
    const { prisma, session } = fakePrisma({ runs: 600, tasks: 1 });
    const original = prisma.task.deleteMany;
    prisma.task.deleteMany = (async (args: never) => {
      session.bootClaimToken = "boot-winner";
      session.state = "booting";
      return original(args);
    }) as never;
    await expect(finalizeBotDestroyAfterProvider({ prisma, home }, input)).rejects.toThrow(
      /claim lost/,
    );
    expect(session.deleted).toBe(false);
  });
});
