import { cronFromNaturalLanguage, cronFromPreset } from "./cron.js";

/**
 * Pacote de equipe: um arquivo Markdown que vira um time inteiro — bots com instruções,
 * um grupo com ordens permanentes e rotinas sugeridas. O formato é documentado em
 * `docs/team-packs.md` e foi desenhado para ser escrito à mão:
 *
 * ```markdown
 * # Equipe: Growth
 *
 * > Ordens permanentes do grupo (opcional).
 *
 * ## Ana — Analista de Dados
 *
 * Instruções da Ana, em Markdown livre.
 *
 * ### Rotina: Relatório diário
 * - Agenda: todo dia às 9h
 * - Fuso: America/Sao_Paulo
 *
 * O prompt da rotina.
 * ```
 *
 * Duas decisões de segurança moram aqui, não na tela:
 * - O formato NÃO tem campo de credencial, conector ou chave — e um pacote que traga
 *   algo com cara de segredo é recusado inteiro, para ninguém colar uma chave num
 *   arquivo que depois circula por aí.
 * - Rotinas chegam sempre pausadas: quem importa revisa e liga uma a uma.
 */

export const TEAM_PACK_LIMITS = {
  bots: 20,
  routinesPerBot: 10,
  nameChars: 80,
  titleChars: 160,
  instructionChars: 20_000,
  promptChars: 20_000,
} as const;

export interface TeamPackRoutine {
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
}

export interface TeamPackBot {
  name: string;
  title: string;
  instructions: string;
  routines: TeamPackRoutine[];
}

export interface TeamPack {
  /** Nome do grupo; `null` quando o arquivo só traz bots avulsos. */
  name: string | null;
  /** Ordens permanentes do grupo (vazio quando não há). */
  instructions: string;
  bots: TeamPackBot[];
}

export type TeamPackResult =
  | { ok: true; pack: TeamPack; warnings: string[] }
  | { ok: false; errors: string[] };

/**
 * O que um segredo colado por engano costuma parecer. Precisos de propósito: um falso
 * positivo bloqueia um pacote honesto, então só formatos inequívocos de chave entram.
 */
const SECRET_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/, label: "uma chave de API (sk-…)" },
  { pattern: /\bghp_[A-Za-z0-9]{20,}\b/, label: "um token do GitHub (ghp_…)" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, label: "uma credencial AWS (AKIA…)" },
  { pattern: /\bxox[bap]-[A-Za-z0-9-]{10,}\b/, label: "um token do Slack (xox…)" },
  { pattern: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, label: "um token JWT" },
  {
    pattern:
      /(?:api[ _-]?key|apikey|secret|token|senha|password)\s*[:=]\s*["'`]?[A-Za-z0-9_.-]{16,}/i,
    label: "um campo de chave/senha preenchido",
  },
];

function findSecret(markdown: string): string | null {
  for (const { pattern, label } of SECRET_PATTERNS) {
    if (pattern.test(markdown)) return label;
  }
  return null;
}

const GROUP_HEADING = /^#\s+(?:equipe|time|team)\s*:\s*(.+?)\s*$/i;
const BOT_HEADING = /^##\s+(.+?)\s*$/;
const ROUTINE_HEADING = /^###\s+(?:rotina|routine)\s*:\s*(.+?)\s*$/i;
const SCHEDULE_ITEM = /^[-*]\s*(?:agenda|schedule|quando|when)\s*:\s*(.+?)\s*$/i;
const TIMEZONE_ITEM = /^[-*]\s*(?:fuso|fuso\s+hor[áa]rio|timezone)\s*:\s*(.+?)\s*$/i;
// Cinco campos de charset cron de verdade: "quando a lua estiver cheia" também tem
// cinco palavras, e não é uma agenda.
const CRON_5_FIELDS = /^[0-9*,/-]+(?:\s+[0-9*,/-]+){4}$/;

/** `## Ana — Analista de Dados` (aceita —, – ou " - ") vira nome + cargo. */
function splitBotHeading(raw: string): { name: string; title: string } {
  const match = raw.match(/^(.+?)\s+(?:—|–|-)\s+(.+)$/);
  if (!match) return { name: raw.trim(), title: "" };
  return { name: (match[1] ?? raw).trim(), title: (match[2] ?? "").trim() };
}

/** Aceita um cron de 5 campos (com ou sem crases) ou uma frase tipo "todo dia às 9h". */
export function scheduleToCron(raw: string): string | null {
  const cleaned = raw.replace(/`/g, "").trim();
  if (CRON_5_FIELDS.test(cleaned)) return cleaned;
  const preset = cronFromNaturalLanguage(cleaned);
  if (!preset) return null;
  return cronFromPreset(preset);
}

function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function parseTeamPack(markdown: string): TeamPackResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const secret = findSecret(markdown);
  if (secret) {
    return {
      ok: false,
      errors: [
        `O arquivo parece conter ${secret}. Pacotes de equipe nunca carregam credenciais — remova a chave e cole cada segredo direto nos ajustes, depois de importar.`,
      ],
    };
  }

  let groupName: string | null = null;
  const groupLines: string[] = [];
  const bots: Array<{
    name: string;
    title: string;
    lines: string[];
    routines: Array<{ name: string; schedule: string | null; timezone: string; lines: string[] }>;
  }> = [];

  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    const routineHeading = line.match(ROUTINE_HEADING);
    const botHeading = !routineHeading && line.match(BOT_HEADING);
    const groupHeading = !routineHeading && !botHeading && line.match(GROUP_HEADING);

    if (groupHeading) {
      if (groupName !== null || bots.length) {
        warnings.push(`Só o primeiro título de equipe vale; "${line.trim()}" foi ignorado.`);
        continue;
      }
      groupName = (groupHeading[1] ?? "").trim();
      continue;
    }
    if (botHeading) {
      bots.push({ ...splitBotHeading(botHeading[1] ?? ""), lines: [], routines: [] });
      continue;
    }
    if (routineHeading) {
      const bot = bots.at(-1);
      if (!bot) {
        errors.push(
          `A rotina "${(routineHeading[1] ?? "").trim()}" aparece antes de qualquer bot. Cada rotina fica dentro da seção (##) do bot dono dela.`,
        );
        continue;
      }
      bot.routines.push({
        name: (routineHeading[1] ?? "").trim(),
        schedule: null,
        timezone: "UTC",
        lines: [],
      });
      continue;
    }

    const bot = bots.at(-1);
    const routine = bot?.routines.at(-1);
    if (routine) {
      const schedule = line.match(SCHEDULE_ITEM);
      if (schedule) {
        routine.schedule = (schedule[1] ?? "").trim();
        continue;
      }
      const timezone = line.match(TIMEZONE_ITEM);
      if (timezone) {
        routine.timezone = (timezone[1] ?? "").trim();
        continue;
      }
      routine.lines.push(line);
    } else if (bot) {
      bot.lines.push(line);
    } else {
      // Preâmbulo: tudo antes do primeiro bot vira ordem permanente do grupo,
      // com ou sem o `>` de citação.
      groupLines.push(line.replace(/^>\s?/, ""));
    }
  }

  if (!bots.length) {
    errors.push(
      "Nenhum bot encontrado. Cada bot é um título de nível 2: `## Nome — Cargo` (o cargo é opcional).",
    );
    return { ok: false, errors };
  }
  if (bots.length > TEAM_PACK_LIMITS.bots) {
    errors.push(
      `O pacote traz ${bots.length} bots; o máximo por importação é ${TEAM_PACK_LIMITS.bots}.`,
    );
  }

  const seen = new Set<string>();
  const packBots: TeamPackBot[] = [];
  for (const bot of bots) {
    if (!bot.name) {
      errors.push("Um dos bots está sem nome (`## ` vazio).");
      continue;
    }
    if (bot.name.length > TEAM_PACK_LIMITS.nameChars) {
      errors.push(
        `O nome "${bot.name.slice(0, 40)}…" passa de ${TEAM_PACK_LIMITS.nameChars} caracteres.`,
      );
      continue;
    }
    if (bot.title.length > TEAM_PACK_LIMITS.titleChars) {
      errors.push(`O cargo de "${bot.name}" passa de ${TEAM_PACK_LIMITS.titleChars} caracteres.`);
      continue;
    }
    const key = bot.name.toLocaleLowerCase("pt-BR");
    if (seen.has(key)) {
      errors.push(`O bot "${bot.name}" aparece duas vezes. Dê um nome único a cada bot.`);
      continue;
    }
    seen.add(key);
    if (bot.routines.length > TEAM_PACK_LIMITS.routinesPerBot) {
      errors.push(
        `"${bot.name}" traz ${bot.routines.length} rotinas; o máximo por bot é ${TEAM_PACK_LIMITS.routinesPerBot}.`,
      );
      continue;
    }

    const routines: TeamPackRoutine[] = [];
    for (const routine of bot.routines) {
      if (!routine.name) {
        errors.push(`Uma rotina de "${bot.name}" está sem nome (\`### Rotina:\` vazio).`);
        continue;
      }
      if (routine.name.length > TEAM_PACK_LIMITS.nameChars) {
        errors.push(
          `O nome da rotina "${routine.name.slice(0, 40)}…" passa de ${TEAM_PACK_LIMITS.nameChars} caracteres.`,
        );
        continue;
      }
      const prompt = routine.lines.join("\n").trim();
      if (!prompt) {
        errors.push(
          `A rotina "${routine.name}" de "${bot.name}" está sem prompt. Escreva o que ela deve fazer nos parágrafos abaixo da lista.`,
        );
        continue;
      }
      if (prompt.length > TEAM_PACK_LIMITS.promptChars) {
        errors.push(
          `O prompt da rotina "${routine.name}" passa de ${TEAM_PACK_LIMITS.promptChars} caracteres.`,
        );
        continue;
      }
      if (!routine.schedule) {
        errors.push(
          `A rotina "${routine.name}" de "${bot.name}" está sem agenda. Adicione \`- Agenda: todo dia às 9h\` ou um cron de 5 campos.`,
        );
        continue;
      }
      const cron = scheduleToCron(routine.schedule);
      if (!cron) {
        errors.push(
          `Não entendi a agenda "${routine.schedule}" da rotina "${routine.name}". Use uma frase simples ("todo dia às 9h", "a cada 30 minutos") ou um cron de 5 campos.`,
        );
        continue;
      }
      if (!validTimezone(routine.timezone)) {
        errors.push(
          `O fuso "${routine.timezone}" da rotina "${routine.name}" não existe. Use um nome IANA, como America/Sao_Paulo.`,
        );
        continue;
      }
      routines.push({
        name: routine.name,
        cron,
        timezone: routine.timezone,
        prompt,
      });
    }

    const instructions = bot.lines.join("\n").trim();
    if (instructions.length > TEAM_PACK_LIMITS.instructionChars) {
      errors.push(
        `As instruções de "${bot.name}" passam de ${TEAM_PACK_LIMITS.instructionChars} caracteres.`,
      );
      continue;
    }
    packBots.push({
      name: bot.name,
      title: bot.title,
      instructions,
      routines,
    });
  }

  const groupInstructions = groupLines.join("\n").trim();
  if (groupInstructions.length > TEAM_PACK_LIMITS.instructionChars) {
    errors.push(`As ordens do grupo passam de ${TEAM_PACK_LIMITS.instructionChars} caracteres.`);
  }
  if (groupName && groupName.length > TEAM_PACK_LIMITS.nameChars) {
    errors.push(`O nome da equipe passa de ${TEAM_PACK_LIMITS.nameChars} caracteres.`);
  }
  if (!groupName && groupInstructions) {
    warnings.push(
      "O arquivo traz ordens de grupo mas nenhum título `# Equipe: …`; sem equipe, essas ordens são ignoradas.",
    );
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    pack: {
      name: groupName || null,
      instructions: groupName ? groupInstructions : "",
      bots: packBots,
    },
    warnings,
  };
}
