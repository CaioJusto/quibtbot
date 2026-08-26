/**
 * Achar dentro da conversa aberta.
 *
 * A busca é do lado de cá: o fio já está na memória, então digitar devolve as ocorrências
 * na hora, sem esperar o servidor e sem uma rota nova. O que não está carregado (histórico
 * antigo, acima do que o fio trouxe) fica de fora — é uma lupa na página, não um índice.
 *
 * A comparação é a mesma do ⌘K: quem digita "reuniao" acha "Reunião", e ponto e vírgula
 * não atrapalham. Por isso o normalizador vem de `command-palette` em vez de nascer de novo.
 */
import { normalizeQuery } from "./command-palette";

/**
 * Um recado é uma lista de blocos de formatos diferentes; a busca só quer os que carregam
 * texto, então o bloco entra como desconhecido e é o `typeof` que decide.
 */
export type SearchableMessage = { id: string; blocks?: readonly unknown[] | null };

/** Todo o texto de um recado numa linha só — bloco de texto, de meta e legenda de arquivo. */
export function messageText(message: SearchableMessage): string {
  return (message.blocks ?? [])
    .map((block) => {
      const text = (block as { text?: unknown } | null)?.text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join(" ");
}

/**
 * Os recados que casam com a busca, na ordem do fio. Devolve ids: quem desenha a tela já
 * tem o recado, e o id é o que serve para rolar até ele e marcá-lo.
 */
export function threadMatches(messages: SearchableMessage[], query: string): string[] {
  const needle = normalizeQuery(query);
  if (!needle) return [];
  return messages
    .filter((message) => normalizeQuery(messageText(message)).includes(needle))
    .map((message) => message.id);
}

/**
 * O próximo (ou o anterior) da lista, dando a volta. Numa busca, chegar ao fim e voltar ao
 * começo é o esperado — parar na última ocorrência pareceria que a busca travou.
 */
export function stepMatch(current: number, count: number, delta: 1 | -1): number {
  if (count <= 0) return 0;
  return (((current + delta) % count) + count) % count;
}
