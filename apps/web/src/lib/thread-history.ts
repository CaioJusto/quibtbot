import type { ThreadMessage } from "@quibt/contracts";

export const HISTORY_PAGE_LIMIT = 50;

export type UnreadDivider = {
  firstMessageId: string;
  count: number;
};

/** Junta páginas e o snapshot vivo sem duplicar mensagens que aparecem nos dois. */
export function mergeThreadMessages(
  older: readonly ThreadMessage[],
  current: readonly ThreadMessage[],
): ThreadMessage[] {
  const byId = new Map<string, ThreadMessage>();
  for (const message of older) byId.set(message.id, message);
  for (const message of current) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => {
    if (left.seq !== right.seq) return left.seq - right.seq;
    return left.id.localeCompare(right.id);
  });
}

/** O cursor da página anterior é a primeira mensagem durável que está na tela. */
export function oldestMessageSeq(messages: readonly ThreadMessage[]): number | null {
  for (const message of messages) {
    if (!message.id.startsWith("progress:") && !message.id.startsWith("subagent:")) {
      return message.seq;
    }
  }
  return null;
}

/**
 * "Tem página anterior?" vem do servidor. Um servidor antigo não manda o campo; aí o
 * palpite conta só mensagens duráveis, porque projeções vivas incham o tamanho da janela.
 */
export function pageHasMore(
  hasMore: boolean | undefined,
  messages: readonly ThreadMessage[],
): boolean {
  if (hasMore !== undefined) return hasMore;
  let durable = 0;
  for (const message of messages) {
    if (!message.id.startsWith("progress:") && !message.id.startsWith("subagent:")) durable += 1;
  }
  return durable >= HISTORY_PAGE_LIMIT;
}

/** Resume as mensagens posteriores ao último ponto que esta conta viu. */
export function unreadDivider(
  messages: readonly ThreadMessage[],
  readThroughSeq: number | null,
): UnreadDivider | null {
  if (readThroughSeq === null) return null;
  const unread = messages.filter(
    (message) =>
      message.seq > readThroughSeq &&
      !message.id.startsWith("progress:") &&
      !message.id.startsWith("subagent:"),
  );
  const first = unread[0];
  return first ? { firstMessageId: first.id, count: unread.length } : null;
}

/** Quando só há o booleano legado de não lida, a última fala da pessoa é o corte honesto. */
export function lastUserMessageSeq(messages: readonly ThreadMessage[]): number | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.seq;
  }
  return null;
}

const STORAGE_KEY = "quibt.thread-read.v1";

export function readThreadCursors(storage: Pick<Storage, "getItem">, accountId: string) {
  try {
    const all = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}") as Record<
      string,
      Record<string, number>
    >;
    return all[accountId] ?? {};
  } catch {
    return {};
  }
}

export function writeThreadCursor(
  storage: Pick<Storage, "getItem" | "setItem">,
  accountId: string,
  threadKey: string,
  seq: number,
) {
  try {
    const all = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}") as Record<
      string,
      Record<string, number>
    >;
    all[accountId] = { ...(all[accountId] ?? {}), [threadKey]: seq };
    storage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Navegação privada ou storage cheio não deve impedir a conversa de abrir.
  }
}
