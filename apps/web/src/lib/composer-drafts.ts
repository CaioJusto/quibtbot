/**
 * O que está escrito no campo, guardado por conversa.
 *
 * O campo de escrever é um só na tela, mas o rascunho não é: cada bot e cada grupo tem o
 * seu. Quem começa uma frase para a Cubee, pula no grupo para conferir uma coisa e volta,
 * acha a frase onde deixou — com o anexo e o recado citado junto. Enquanto o rascunho era
 * um estado único do app, a frase seguia a pessoa para a conversa errada e o Enter seguinte
 * mandava para o bot errado.
 *
 * Só o texto atravessa fechar o app. O anexo já subiu para o bot daquela conversa e volta
 * a existir quando ele é escolhido de novo; o recado citado só faz sentido com o fio
 * carregado na tela.
 */
import type { Attachment } from "./attachments";

export type ComposerDraft = {
  text: string;
  attachments: Attachment[];
  /** Recado que o próximo envio responde, pelo id — o objeto vive no fio, não aqui. */
  replyToId: string | null;
};

export type DraftMap = Record<string, ComposerDraft>;

export const EMPTY_DRAFT: ComposerDraft = Object.freeze({
  text: "",
  attachments: [],
  replyToId: null,
}) as ComposerDraft;

const STORAGE_KEY = "quibt.composer-drafts.v1";
/** Rascunho é frase, não arquivo colado inteiro: acima disto não vai para o disco. */
const MAX_STORED_CHARS = 20_000;
/** Quem usa dezenas de bots não precisa carregar o rascunho de todos eles para sempre. */
const MAX_STORED_DRAFTS = 50;

/** A conversa aberta em uma palavra. É a chave do rascunho, e a caixa de entrada tem a sua. */
export function conversationKey(params: { botId?: string; groupId?: string }): string {
  if (params.groupId) return `group:${params.groupId}`;
  if (params.botId) return `bot:${params.botId}`;
  return "inbox";
}

export function draftAt(drafts: DraftMap, key: string): ComposerDraft {
  return drafts[key] ?? EMPTY_DRAFT;
}

export function isEmptyDraft(draft: ComposerDraft): boolean {
  return draft.text === "" && draft.attachments.length === 0 && draft.replyToId === null;
}

/**
 * Escreve o rascunho de uma conversa. Rascunho vazio sai do mapa em vez de virar entrada
 * morta — assim o que vai para o disco é só o que alguém realmente deixou escrito.
 */
export function putDraft(drafts: DraftMap, key: string, draft: ComposerDraft): DraftMap {
  if (isEmptyDraft(draft)) {
    if (!(key in drafts)) return drafts;
    const next = { ...drafts };
    delete next[key];
    return next;
  }
  return { ...drafts, [key]: draft };
}

/** Depois de enviar, some o rascunho daquela conversa — e só o daquela. */
export function clearDraft(drafts: DraftMap, key: string): DraftMap {
  return putDraft(drafts, key, EMPTY_DRAFT);
}

/**
 * O recorte que sobrevive ao recarregar: chave → texto.
 *
 * Quando há rascunho demais para o disco, quem sai são os mais antigos. Uma entrada nasce no
 * fim do mapa e é apagada assim que o campo esvazia, então a ordem das chaves já é, na
 * prática, a ordem em que as conversas voltaram a ter texto — e o corte fica no fim.
 */
export function storableTexts(drafts: DraftMap): Record<string, string> {
  const written = Object.entries(drafts)
    .map(([key, draft]) => [key, draft.text.trim() ? draft.text.slice(0, MAX_STORED_CHARS) : ""])
    .filter(([, text]) => text) as Array<[string, string]>;
  return Object.fromEntries(written.slice(-MAX_STORED_DRAFTS));
}

export function draftsFromTexts(texts: Record<string, unknown>): DraftMap {
  const drafts: DraftMap = {};
  for (const [key, value] of Object.entries(texts)) {
    if (typeof value !== "string" || !value.trim()) continue;
    drafts[key] = { text: value.slice(0, MAX_STORED_CHARS), attachments: [], replyToId: null };
  }
  return drafts;
}

/**
 * O disco do navegador some em aba anônima, em iframe fechado e no render do servidor.
 * Rascunho é conveniência: quando não dá para guardar, o app segue sem ele.
 */
function localStore(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readStoredDrafts(storage: Storage | null = localStore()): DraftMap {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return draftsFromTexts(parsed as Record<string, unknown>);
  } catch {
    return {};
  }
}

export function writeStoredDrafts(drafts: DraftMap, storage: Storage | null = localStore()): void {
  if (!storage) return;
  try {
    const texts = storableTexts(drafts);
    if (Object.keys(texts).length === 0) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, JSON.stringify(texts));
  } catch {
    // Cota cheia ou disco bloqueado: o rascunho continua na tela, só não sobrevive ao F5.
  }
}
