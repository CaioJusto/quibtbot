import { describe, expect, it } from "vitest";
import { createDb } from "./client.js";

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

/**
 * Apagar um bot com histórico longo passava dos 5 s que o Prisma dá de graça para uma
 * transação interativa, e a transação era desfeita depois de o computador já ter sido
 * destruído no provedor. Aqui a prova é direta: uma transação que dura mais de 5 s
 * termina bem com o prazo novo, e o prazo continua sendo obedecido quando é curto.
 */
describeDb("interactive transaction deadline", () => {
  it("finishes a transaction that takes longer than the Prisma default of 5s", async () => {
    const db = createDb(process.env.DATABASE_URL!, { env: {} });
    try {
      const started = Date.now();
      await db.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_sleep(6)::text`;
      });
      expect(Date.now() - started).toBeGreaterThan(5_000);
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  }, 40_000);

  it("still gives up when the deadline is reached", async () => {
    const db = createDb(process.env.DATABASE_URL!, { transactionTimeoutMs: 1_000, env: {} });
    try {
      await expect(
        db.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT pg_sleep(3)::text`;
        }),
      ).rejects.toThrow();
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  }, 40_000);
});
