import { describe, expect, it } from "vitest";
import { parseTeamPack, scheduleToCron, TEAM_PACK_LIMITS } from "./team-pack.js";

const FULL_PACK = `# Equipe: Growth

> Falem sempre em português.
> Nunca publiquem nada sem aprovação.

## Ana — Analista de Dados

Você cuida dos números da empresa.
Responda sempre com uma tabela.

### Rotina: Relatório diário
- Agenda: todo dia às 9h
- Fuso: America/Sao_Paulo

Monte o resumo de ontem e mande no grupo.

## Beto

Você escreve os textos.
`;

describe("parseTeamPack", () => {
  it("lê equipe, ordens do grupo, bots com cargo e rotina agendada", () => {
    const result = parseTeamPack(FULL_PACK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pack.name).toBe("Growth");
    expect(result.pack.instructions).toContain("Falem sempre em português.");
    expect(result.pack.instructions).toContain("Nunca publiquem nada");
    expect(result.pack.bots).toHaveLength(2);

    const ana = result.pack.bots[0]!;
    expect(ana.name).toBe("Ana");
    expect(ana.title).toBe("Analista de Dados");
    expect(ana.instructions).toContain("Responda sempre com uma tabela.");
    expect(ana.routines).toHaveLength(1);
    expect(ana.routines[0]).toMatchObject({
      name: "Relatório diário",
      cron: "0 9 * * *",
      timezone: "America/Sao_Paulo",
    });
    expect(ana.routines[0]!.prompt).toContain("resumo de ontem");

    const beto = result.pack.bots[1]!;
    expect(beto.title).toBe("");
    expect(beto.routines).toHaveLength(0);
  });

  it("aceita um pacote só de bots, sem equipe", () => {
    const result = parseTeamPack("## Solo\n\nInstruções do solo.\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pack.name).toBeNull();
    expect(result.pack.bots).toHaveLength(1);
  });

  it("aceita cron de 5 campos com crases e título em inglês", () => {
    const result = parseTeamPack(
      "# Team: Ops\n\n## Op\n\nx\n\n### Routine: Ping\n- Schedule: `*/30 * * * *`\n\nPing.\n",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pack.name).toBe("Ops");
    expect(result.pack.bots[0]!.routines[0]!.cron).toBe("*/30 * * * *");
    expect(result.pack.bots[0]!.routines[0]!.timezone).toBe("UTC");
  });

  it("recusa o pacote inteiro quando há algo com cara de credencial", () => {
    const result = parseTeamPack(
      "## Bot\n\nUse a chave sk-abc123def456ghi789jkl012 para chamar a API.\n",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("credenciais");
  });

  it("recusa campo de senha preenchido mesmo sem prefixo conhecido", () => {
    const result = parseTeamPack("## Bot\n\napi_key: minhachavesecreta123\n");
    expect(result.ok).toBe(false);
  });

  it("explica agenda ilegível, rotina sem prompt e rotina fora de bot", () => {
    const semAgenda = parseTeamPack("## A\n\nx\n\n### Rotina: R\n\nFaz algo.\n");
    expect(semAgenda.ok).toBe(false);
    if (!semAgenda.ok) expect(semAgenda.errors[0]).toContain("sem agenda");

    const agendaRuim = parseTeamPack(
      "## A\n\nx\n\n### Rotina: R\n- Agenda: quando a lua estiver cheia\n\nFaz algo.\n",
    );
    expect(agendaRuim.ok).toBe(false);
    if (!agendaRuim.ok) expect(agendaRuim.errors[0]).toContain("Não entendi a agenda");

    const semPrompt = parseTeamPack("## A\n\nx\n\n### Rotina: R\n- Agenda: todo dia às 9h\n");
    expect(semPrompt.ok).toBe(false);
    if (!semPrompt.ok) expect(semPrompt.errors[0]).toContain("sem prompt");

    const semBot = parseTeamPack(
      "# Equipe: X\n\n### Rotina: R\n- Agenda: todo dia\n\nOi.\n## A\n\nx\n",
    );
    expect(semBot.ok).toBe(false);
    if (!semBot.ok) expect(semBot.errors[0]).toContain("antes de qualquer bot");
  });

  it("recusa fuso inexistente, nomes duplicados e pacote sem bots", () => {
    const fuso = parseTeamPack(
      "## A\n\nx\n\n### Rotina: R\n- Agenda: todo dia às 9h\n- Fuso: America/Nao_Existe\n\nOi.\n",
    );
    expect(fuso.ok).toBe(false);
    if (!fuso.ok) expect(fuso.errors[0]).toContain("não existe");

    const dup = parseTeamPack("## Ana\n\nx\n\n## ana\n\ny\n");
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.errors[0]).toContain("duas vezes");

    const vazio = parseTeamPack("# Equipe: X\n\nSó texto.\n");
    expect(vazio.ok).toBe(false);
    if (!vazio.ok) expect(vazio.errors[0]).toContain("Nenhum bot");
  });

  it("limita a quantidade de bots por importação", () => {
    const many = Array.from(
      { length: TEAM_PACK_LIMITS.bots + 1 },
      (_, i) => `## Bot ${i + 1}\n\nx\n`,
    ).join("\n");
    const result = parseTeamPack(many);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("máximo por importação");
  });

  it("recusa cargo e nome de rotina maiores que os formulários", () => {
    const longTitle = parseTeamPack(`## Ana — ${"x".repeat(TEAM_PACK_LIMITS.titleChars + 1)}\n`);
    expect(longTitle.ok).toBe(false);
    if (!longTitle.ok) expect(longTitle.errors[0]).toContain("cargo");

    const longRoutine = parseTeamPack(
      `## Ana\n\nOi.\n\n### Rotina: ${"x".repeat(TEAM_PACK_LIMITS.nameChars + 1)}\n- Agenda: todo dia\n\nFaça.\n`,
    );
    expect(longRoutine.ok).toBe(false);
    if (!longRoutine.ok) expect(longRoutine.errors[0]).toContain("nome da rotina");
  });

  it("preserva títulos Markdown comuns dentro das instruções do bot", () => {
    const result = parseTeamPack("# Equipe: Docs\n\n## Ana\n\n# Regras\n\nExplique bem.\n");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pack.bots[0]?.instructions).toContain("# Regras");
  });

  it("avisa (sem falhar) sobre segundo título de equipe e ordens sem equipe", () => {
    const twoTitles = parseTeamPack("# Equipe: A\n\n## B\n\nx\n\n# Equipe: C\n");
    expect(twoTitles.ok).toBe(true);
    if (twoTitles.ok) {
      expect(twoTitles.pack.name).toBe("A");
      expect(twoTitles.warnings[0]).toContain("ignorado");
    }

    const orphanOrders = parseTeamPack("> Ordem solta\n\n## B\n\nx\n");
    expect(orphanOrders.ok).toBe(true);
    if (orphanOrders.ok) {
      expect(orphanOrders.pack.instructions).toBe("");
      expect(orphanOrders.warnings[0]).toContain("nenhum título");
    }
  });
});

describe("scheduleToCron", () => {
  it("passa cron de 5 campos adiante e traduz frases", () => {
    expect(scheduleToCron("0 9 * * 1-5")).toBe("0 9 * * 1-5");
    expect(scheduleToCron("`0 9 * * *`")).toBe("0 9 * * *");
    expect(scheduleToCron("a cada 30 minutos")).toBe("*/30 * * * *");
    expect(scheduleToCron("isso não é agenda nenhuma")).toBeNull();
  });
});
