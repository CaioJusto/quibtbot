import type { ThreadSearchResult } from "@quibt/contracts";

/**
 * Busca por teclado do app: bots, grupos e ações, sem sair do teclado.
 *
 * Quem escreve em português digita "joao" para achar "João" e "reuniao" para achar
 * "Reunião": a comparação ignora acento e pontuação. As letras da busca precisam
 * aparecer na ordem, mas não coladas ("cr bt" acha "Criar bot"), e começo de palavra
 * vale mais que meio de palavra para o resultado óbvio subir.
 */

export type PaletteAction =
  | { kind: "bot"; id: string }
  | { kind: "group"; id: string }
  | { kind: "message"; botId: string | null; groupId: string | null; messageId: string }
  | { kind: "panel"; panel: "create" | "create-group" | "settings" | "computer" | "routine" }
  | { kind: "route"; path: string };

export type PaletteItem = {
  id: string;
  label: string;
  /** Linha de apoio: o que a ação faz, ou o título do bot. */
  detail?: string;
  /** Palavras que também casam com a busca sem aparecer no rótulo. */
  keywords?: string[];
  action: PaletteAction;
};

/** Sem acento, sem pontuação, minúsculo — pontuação vira espaço. */
export function normalizeQuery(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Nota de um texto para um pedaço da busca, ou `null` quando as letras não cabem
 * na ordem. Começo de palavra soma 4, letra colada na anterior soma 3; match que
 * começa mais tarde ou em texto muito longo perde um pouco, para desempate.
 */
export function scoreTerm(text: string, term: string): number | null {
  if (!term) return 0;
  let score = 0;
  let cursor = 0;
  let previous = -2;
  let first = -1;
  for (let index = 0; index < text.length && cursor < term.length; index += 1) {
    if (text[index] !== term[cursor]) continue;
    if (first < 0) first = index;
    let step = 1;
    if (index === 0 || text[index - 1] === " ") step += 4;
    if (previous === index - 1) step += 3;
    score += step;
    previous = index;
    cursor += 1;
  }
  if (cursor < term.length) return null;
  return score - first * 0.1 - text.length * 0.02;
}

function scoreItem(item: PaletteItem, terms: string[]): number | null {
  const haystacks = [item.label, item.detail ?? "", ...(item.keywords ?? [])]
    .map(normalizeQuery)
    .filter((text) => text.length > 0);
  let total = 0;
  for (const term of terms) {
    let best: number | null = null;
    for (const text of haystacks) {
      const score = scoreTerm(text, term);
      if (score != null && (best == null || score > best)) best = score;
    }
    // Um termo que não casa em lugar nenhum descarta o item inteiro: quem digita
    // duas palavras está estreitando a busca, não pedindo qualquer uma das duas.
    if (best == null) return null;
    total += best;
  }
  return total;
}

/** Itens que casam com a busca, do mais provável para o menos. Busca vazia devolve tudo. */
export function filterPalette(items: PaletteItem[], query: string): PaletteItem[] {
  const terms = normalizeQuery(query).split(" ").filter(Boolean);
  if (terms.length === 0) return items;
  return items
    .map((item) => ({ item, score: scoreItem(item, terms) }))
    .filter((row): row is { item: PaletteItem; score: number } => row.score != null)
    .sort((left, right) => right.score - left.score)
    .map((row) => row.item);
}

/** Anda na lista sem dar a volta: seta para baixo no fim fica no fim. */
export function moveHighlight(current: number, count: number, delta: -1 | 1): number {
  if (count <= 0) return 0;
  const bounded = Math.min(Math.max(current, 0), count - 1);
  return Math.min(Math.max(bounded + delta, 0), count - 1);
}

export const PALETTE_ACTIONS: PaletteItem[] = [
  {
    id: "action:create",
    label: "Criar um bot",
    detail: "Um personagem novo, com a própria conversa",
    keywords: ["novo", "adicionar", "personagem"],
    action: { kind: "panel", panel: "create" },
  },
  {
    id: "action:create-group",
    label: "Criar um grupo",
    detail: "Vários bots na mesma conversa",
    keywords: ["novo", "equipe", "time"],
    action: { kind: "panel", panel: "create-group" },
  },
  {
    id: "action:computer",
    label: "Abrir o computador",
    detail: "A tela do bot desta conversa",
    keywords: ["tela", "desktop", "monitor"],
    action: { kind: "panel", panel: "computer" },
  },
  {
    id: "action:routine",
    label: "Ensinar uma tarefa",
    detail: "Rotina que roda sozinha na hora marcada",
    keywords: ["rotina", "agendar", "horario", "automatico"],
    action: { kind: "panel", panel: "routine" },
  },
  {
    id: "action:settings",
    label: "Ajustes do bot",
    detail: "Nome, instruções, memória e conexões",
    keywords: ["configuracoes", "preferencias"],
    action: { kind: "panel", panel: "settings" },
  },
  {
    id: "action:account",
    label: "Conta",
    detail: "Modelo, chave e aparelhos",
    keywords: ["perfil", "chave", "modelo"],
    action: { kind: "route", path: "/account" },
  },
  {
    id: "action:phone",
    label: "Conectar o celular",
    detail: "Código para entrar no app do telefone",
    keywords: ["telefone", "parear", "codigo", "mobile"],
    action: { kind: "route", path: "/settings/phone" },
  },
  {
    id: "action:machine",
    label: "Máquina dos bots",
    detail: "Onde o computador dos bots roda",
    keywords: ["docker", "vps", "servidor", "box", "e2b"],
    action: { kind: "route", path: "/settings/machine" },
  },
];

/** Bots e grupos viram itens; bot escondido fica de fora, como na barra lateral. */
export function buildPaletteItems(
  bots: Array<{ id: string; name: string; title?: string | null; hidden?: boolean }>,
  groups: Array<{ id: string; name: string }>,
  options?: { hasActiveBot?: boolean },
): PaletteItem[] {
  const botItems: PaletteItem[] = bots
    .filter((bot) => !bot.hidden)
    .map((bot) => ({
      id: `bot:${bot.id}`,
      label: bot.name,
      detail: bot.title?.trim() ? bot.title : "Abrir a conversa",
      keywords: ["bot", "conversa"],
      action: { kind: "bot", id: bot.id },
    }));
  const groupItems: PaletteItem[] = groups.map((group) => ({
    id: `group:${group.id}`,
    label: group.name,
    detail: "Abrir o grupo",
    keywords: ["grupo", "equipe"],
    action: { kind: "group", id: group.id },
  }));
  // Sem conversa aberta não há computador nem ajustes de bot para abrir; oferecer
  // isso daria um item que não faz nada ao ser escolhido.
  const actions = options?.hasActiveBot
    ? PALETTE_ACTIONS
    : PALETTE_ACTIONS.filter(
        (item) => !["action:computer", "action:routine", "action:settings"].includes(item.id),
      );
  return [...botItems, ...groupItems, ...actions];
}

export function messagePaletteItems(results: ThreadSearchResult[]): PaletteItem[] {
  return results.map((result) => {
    const compact = result.text.replace(/\s+/g, " ").trim();
    return {
      id: `message:${result.messageId}`,
      label: compact.length > 90 ? `${compact.slice(0, 89)}…` : compact,
      detail: `Mensagem em ${result.ownerName}`,
      keywords: ["mensagem", result.ownerName],
      action: {
        kind: "message",
        botId: result.botId,
        groupId: result.groupId,
        messageId: result.messageId,
      },
    };
  });
}

/** ⌘K no Mac, Ctrl+K no resto. */
export function opensPalette(event: { key: string; metaKey: boolean; ctrlKey: boolean }): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
}
