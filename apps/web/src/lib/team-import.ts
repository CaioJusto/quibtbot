import type { TeamPack } from "@quibt/core";

/**
 * Executa um pacote de equipe já parseado usando os MESMOS endpoints das telas de criar
 * bot, grupo e rotina — nada de caminho privilegiado de importação. A sequência não é
 * atômica de propósito: se o terceiro bot falhar (limite do plano, nome inválido), os
 * dois primeiros ficam e o relatório diz exatamente o que faltou, em vez de desfazer
 * trabalho bom.
 */

export interface TeamImportClient {
  createBot(input: { name: string; title: string; instructions: string }): Promise<{ id: string }>;
  createGroup(input: { name: string; botIds: string[] }): Promise<{ id: string }>;
  updateGroup(input: { groupId: string; instructions: string }): Promise<unknown>;
  createRoutine(input: {
    botId: string;
    name: string;
    prompt: string;
    cron: string;
    timezone: string;
    active: boolean;
  }): Promise<unknown>;
}

export interface TeamImportReport {
  createdBots: Array<{ id: string; name: string }>;
  groupId: string | null;
  routinesCreated: number;
  failures: string[];
}

export async function importTeamPack(
  pack: TeamPack,
  client: TeamImportClient,
): Promise<TeamImportReport> {
  const report: TeamImportReport = {
    createdBots: [],
    groupId: null,
    routinesCreated: 0,
    failures: [],
  };

  for (const bot of pack.bots) {
    let botId: string;
    try {
      const created = await client.createBot({
        name: bot.name,
        title: bot.title,
        instructions: bot.instructions,
      });
      botId = created.id;
      report.createdBots.push({ id: created.id, name: bot.name });
    } catch (error) {
      report.failures.push(
        `Não criei o bot "${bot.name}": ${error instanceof Error ? error.message : "erro desconhecido"}`,
      );
      continue;
    }
    for (const routine of bot.routines) {
      try {
        // Rotinas de pacote chegam SEMPRE pausadas: quem importou revisa e liga uma a uma.
        await client.createRoutine({
          botId,
          name: routine.name,
          prompt: routine.prompt,
          cron: routine.cron,
          timezone: routine.timezone,
          active: false,
        });
        report.routinesCreated += 1;
      } catch (error) {
        report.failures.push(
          `Não criei a rotina "${routine.name}" de "${bot.name}": ${error instanceof Error ? error.message : "erro desconhecido"}`,
        );
      }
    }
  }

  // O grupo só nasce com quem nasceu: um pacote de 5 bots em que 2 falharam vira um
  // grupo de 3, e o relatório conta o resto.
  if (pack.name && report.createdBots.length) {
    try {
      const group = await client.createGroup({
        name: pack.name,
        botIds: report.createdBots.map((bot) => bot.id),
      });
      report.groupId = group.id;
      if (pack.instructions) {
        await client.updateGroup({ groupId: group.id, instructions: pack.instructions });
      }
    } catch (error) {
      report.failures.push(
        `Não criei o grupo "${pack.name}": ${error instanceof Error ? error.message : "erro desconhecido"}`,
      );
    }
  }

  return report;
}
