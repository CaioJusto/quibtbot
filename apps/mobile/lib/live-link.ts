import type { LiveFeedStatus } from "@quibt/core";

/**
 * O fio da conversa sobre uma rede de celular.
 *
 * O SSE é o caminho imediato. O poll de segurança existia para os proxies antigos que seguram
 * o stream num buffer — mas rodava a cada 1,5 s, sempre, mesmo com o fio saudável: cada volta
 * trocava o snapshot e a lista tremia. Aqui fica a decisão pura de **quando** vale pollar
 * (espelho do que a web faz em `Shell.tsx`): só com o fio caído, ou quando o bot está
 * trabalhando e nada chegou há um bom tempo.
 */

/** De quanto em quanto tempo a conversa confere se precisa buscar o retrato de novo. */
export const SAFETY_POLL_TICK_MS = 2_000;
/** Durante um run, este silêncio no fio já é suspeito: o proxy pode estar segurando o SSE. */
export const QUIET_RUN_MS = 8_000;

export function shouldSafetyPoll(input: {
  status: LiveFeedStatus;
  /** O bot está no meio de um run (queued/leased/running). */
  working: boolean;
  /** Instante do último evento que chegou pelo fio. */
  lastEventAt: number;
  now: number;
  quietMs?: number;
}): boolean {
  // Fio caído: o feed já pontua entre tentativas, mas uma tentativa que pendura num socket
  // meio-aberto não pontua — a conversa não pode ficar parada enquanto isso.
  if (input.status === "reconnecting" || input.status === "offline") return true;
  if (!input.working) return false;
  return input.now - input.lastEventAt >= (input.quietMs ?? QUIET_RUN_MS);
}

/**
 * Sem servidor a tela mostrava um texto vermelho solto ("Network request failed"). Isto
 * reconhece as falhas de rede — as do `fetch`, as que o próprio `apiFetch` traduz e os 5xx
 * do proxy — para a tela falar em português e no lugar certo.
 */
export function isConnectionProblem(message: string | null | undefined): boolean {
  if (!message) return false;
  return /network request failed|failed to fetch|networkerror|load failed|demorou demais|conexão falhou|não foi possível alcançar|ECONNREFUSED|timed? ?out|HTTP 5\d\d/i.test(
    message,
  );
}

export const CONNECTION_PROBLEM_MESSAGE =
  "Sem contato com o seu Quibt. Confira a conexão e tente de novo.";

/** A mensagem que a pessoa lê: rede caída vira uma frase nossa; o resto passa como veio. */
export function userFacingError(error: unknown, fallback: string): string {
  const message = error instanceof Error && error.message ? error.message : fallback;
  return isConnectionProblem(message) ? CONNECTION_PROBLEM_MESSAGE : message;
}

/**
 * O chip discreto sob o cabeçalho. `offline` é o feed já ter desistido algumas vezes: aí
 * vale dizer que o Quibt pode estar desligado. Um poll que falhou por rede, com o fio ainda
 * de pé, é só "reconectando" — o feed vai perceber e trocar de estado sozinho.
 */
export function connectionChipLabel(input: {
  status: LiveFeedStatus;
  pollFailed: boolean;
}): string | null {
  if (input.status === "offline") return "Sem contato com o seu Quibt";
  if (input.status === "reconnecting" || input.pollFailed) return "Reconectando…";
  return null;
}
