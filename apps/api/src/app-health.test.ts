import type { PrismaClient } from "@quibt/db";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

const TEST_DATABASE_URL = "postgres://test-only.invalid/quibt";

function prismaWith(heartbeatSeenAt: Date | null) {
  const deployment = { id: "default", ownerUserId: "owner", signupsEnabled: false };
  const claim = { id: "default", claimedAt: new Date() };
  return {
    deploymentSettings: { upsert: async () => deployment, findUnique: async () => deployment },
    deploymentClaim: { upsert: async () => claim, findUnique: async () => claim },
    workerHeartbeat: {
      findFirst: async () => (heartbeatSeenAt ? { seenAt: heartbeatSeenAt } : null),
    },
    $queryRawUnsafe: async () => 1,
    $disconnect: async () => undefined,
  } as unknown as PrismaClient;
}

async function health(prisma: PrismaClient, wakeupDriver: "graphile" | "memory") {
  const handles = await createApp({ prisma, databaseUrl: TEST_DATABASE_URL, wakeupDriver });
  try {
    const res = await handles.app.request("http://localhost/health");
    expect(res.status).toBe(200);
    return (await res.json()) as { worker: { alive: boolean; lastSeenAt: string | null } };
  } finally {
    await handles.stop();
  }
}

describe("GET /health diz se há worker", () => {
  it("com Graphile e nenhum batimento, o worker não está rodando", async () => {
    const body = await health(prismaWith(null), "graphile");
    expect(body.worker).toEqual({ alive: false, lastSeenAt: null });
  });

  it("com Graphile e um batimento recente, está vivo", async () => {
    const seen = new Date(Date.now() - 3_000);
    const body = await health(prismaWith(seen), "graphile");
    expect(body.worker).toEqual({ alive: true, lastSeenAt: seen.toISOString() });
  });

  it("com o wakeup em memória a própria API executa os runs: sempre vivo", async () => {
    const body = await health(prismaWith(null), "memory");
    expect(body.worker.alive).toBe(true);
  });
});
