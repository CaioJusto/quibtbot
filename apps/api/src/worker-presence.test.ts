import type { PrismaClient } from "@quibt/db";
import { describe, expect, it } from "vitest";
import { createWorkerPresenceReader } from "./worker-presence.js";

const now = new Date("2026-08-25T12:00:00.000Z");

function prismaWith(seenAt: Date | null | Error) {
  return {
    workerHeartbeat: {
      findFirst: async () => {
        if (seenAt instanceof Error) throw seenAt;
        return seenAt ? { seenAt } : null;
      },
    },
  } as unknown as PrismaClient;
}

describe("createWorkerPresenceReader", () => {
  it("lê o batimento mais recente do banco", async () => {
    const seen = new Date(now.getTime() - 20_000);
    const reader = createWorkerPresenceReader({ prisma: prismaWith(seen), inProcess: false });
    expect(await reader.read(now)).toEqual({ alive: true, lastSeenAt: seen.toISOString() });
    expect(await reader.seenAt()).toEqual(seen);
  });

  it("sem batimento nenhum, o worker está morto", async () => {
    const reader = createWorkerPresenceReader({ prisma: prismaWith(null), inProcess: false });
    expect(await reader.read(now)).toEqual({ alive: false, lastSeenAt: null });
  });

  it("um banco que falha responde morto em vez de derrubar a leitura", async () => {
    const reader = createWorkerPresenceReader({
      prisma: prismaWith(new Error("caiu")),
      inProcess: false,
    });
    expect(await reader.read(now)).toEqual({ alive: false, lastSeenAt: null });
  });

  it("com o wakeup em memória a própria API é o worker e está sempre viva", async () => {
    const reader = createWorkerPresenceReader({
      prisma: prismaWith(new Error("nem deveria ler")),
      inProcess: true,
    });
    const presence = await reader.read(now);
    expect(presence.alive).toBe(true);
    expect(presence.lastSeenAt).not.toBeNull();
  });
});
