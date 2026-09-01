import { describe, expect, it } from "vitest";
import { importTeamPack, type TeamImportClient } from "./team-import.js";

function fakeClient(overrides: Partial<TeamImportClient> = {}) {
  const calls: Record<string, unknown[]> = {
    createBot: [],
    createGroup: [],
    updateGroup: [],
    createRoutine: [],
  };
  let botSeq = 0;
  const client: TeamImportClient = {
    async createBot(input) {
      calls.createBot!.push(input);
      botSeq += 1;
      return { id: `bot-${botSeq}` };
    },
    async createGroup(input) {
      calls.createGroup!.push(input);
      return { id: "group-1" };
    },
    async updateGroup(input) {
      calls.updateGroup!.push(input);
      return {};
    },
    async createRoutine(input) {
      calls.createRoutine!.push(input);
      return {};
    },
    ...overrides,
  };
  return { client, calls };
}

const PACK = {
  name: "Growth",
  instructions: "Falem português.",
  bots: [
    {
      name: "Ana",
      title: "Analista",
      instructions: "Cuide dos números.",
      routines: [
        {
          name: "Relatório",
          cron: "0 9 * * *",
          timezone: "America/Sao_Paulo",
          prompt: "Resuma ontem.",
        },
      ],
    },
    { name: "Beto", title: "", instructions: "", routines: [] },
  ],
};

describe("importTeamPack", () => {
  it("cria bots, rotinas pausadas e o grupo com as ordens permanentes", async () => {
    const { client, calls } = fakeClient();
    const report = await importTeamPack(PACK, client);

    expect(report.createdBots.map((bot) => bot.name)).toEqual(["Ana", "Beto"]);
    expect(report.groupId).toBe("group-1");
    expect(report.routinesCreated).toBe(1);
    expect(report.failures).toEqual([]);

    expect(calls.createRoutine![0]).toMatchObject({ botId: "bot-1", active: false });
    expect(calls.createGroup![0]).toMatchObject({
      name: "Growth",
      botIds: ["bot-1", "bot-2"],
    });
    expect(calls.updateGroup![0]).toMatchObject({
      groupId: "group-1",
      instructions: "Falem português.",
    });
  });

  it("segue em frente quando um bot falha e monta o grupo só com quem nasceu", async () => {
    const { client, calls } = fakeClient({
      async createBot(input) {
        if (input.name === "Ana") throw new Error("limite de bots");
        return { id: "bot-ok" };
      },
    });
    const report = await importTeamPack(PACK, client);

    expect(report.createdBots.map((bot) => bot.name)).toEqual(["Beto"]);
    expect(report.failures[0]).toContain('Não criei o bot "Ana"');
    expect(report.failures[0]).toContain("limite de bots");
    // A rotina era da Ana; sem a Ana, nada de rotina.
    expect(report.routinesCreated).toBe(0);
    expect(calls.createGroup![0]).toMatchObject({ botIds: ["bot-ok"] });
  });

  it("não cria grupo num pacote sem equipe, e relata falha de rotina sem parar", async () => {
    const { client, calls } = fakeClient({
      async createRoutine() {
        throw new Error("cron inválido");
      },
    });
    const report = await importTeamPack({ ...PACK, name: null, instructions: "" }, client);

    expect(report.groupId).toBeNull();
    expect(calls.createGroup).toHaveLength(0);
    expect(report.createdBots).toHaveLength(2);
    expect(report.failures[0]).toContain('rotina "Relatório"');
  });
});
