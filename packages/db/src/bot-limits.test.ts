import { describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createRepos, MAX_BOT_GROUPS, MAX_BOTS } from "./repos.js";

const actor = { workspaceId: "ws-1", userId: "user-1" } as never;

/** Um prisma de mentira só com o que o caminho do teto usa. */
function prismaWithCounts(input: { bots: number; groups: number }) {
  const tx = {
    $executeRaw: async () => 0,
    bot: {
      count: async () => input.bots,
      findFirst: async () => null,
      findMany: async () => [],
      create: async () => {
        throw new Error("CREATED-PAST-LIMIT");
      },
    },
    botGroup: {
      count: async () => input.groups,
      create: async () => {
        throw new Error("CREATED-PAST-LIMIT");
      },
    },
  };
  return {
    ...tx,
    $transaction: async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
  } as unknown as PrismaClient;
}

describe("teto absoluto de bots e grupos", () => {
  it("recusa o bot 31 com uma frase que diz o que fazer", async () => {
    const repos = createRepos(prismaWithCounts({ bots: MAX_BOTS, groups: 0 }));
    await expect(
      repos.createBot(actor, {
        name: "Bot 31",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      }),
    ).rejects.toThrow(/limite de 30 bots/);
  });

  it("recusa o grupo 31", async () => {
    const repos = createRepos(prismaWithCounts({ bots: 0, groups: MAX_BOT_GROUPS }));
    await expect(repos.createBotGroup(actor, { name: "Grupo 31", botIds: [] })).rejects.toThrow(
      /limite de 30 grupos/,
    );
  });
});
