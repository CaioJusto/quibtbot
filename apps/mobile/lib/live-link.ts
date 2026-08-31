import { isTransientNetworkMessage, type LiveFeedStatus } from "@quibt/core";

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
  /**
   * O último poll falhou por rede e a tela está dizendo "Reconectando…". Insistir é o que
   * apaga esse chip: com o fio de pé e o bot parado nada mais chamaria o `reload`, e o
   * aviso ficava preso na tela com tudo funcionando.
   */
  pollFailed?: boolean;
}): boolean {
  // Fio caído: o feed já pontua entre tentativas, mas uma tentativa que pendura num socket
  // meio-aberto não pontua — a conversa não pode ficar parada enquanto isso.
  if (input.status === "reconnecting" || input.status === "offline") return true;
  if (input.pollFailed) return true;
  if (!input.working) return false;
  return input.now - input.lastEventAt >= (input.quietMs ?? QUIET_RUN_MS);
}

/** O que o poll de segurança pergunta a cada tique. Tudo por função: o valor muda embaixo. */
export type SafetyPollerOptions = {
  status: () => LiveFeedStatus;
  working: () => boolean;
  lastEventAt: () => number;
  pollFailed?: () => boolean;
  /** App em segundo plano: o fio está pausado e o poll também. */
  paused?: () => boolean;
  reload: () => void;
  tickMs?: number;
  quietMs?: number;
  now?: () => number;
};

/**
 * O relógio do poll de segurança, separado da tela para poder ser testado com o tempo na
 * mão: a decisão é do `shouldSafetyPoll`, aqui fica só o tique. Devolve como parar.
 */
export function createSafetyPoller(options: SafetyPollerOptions): () => void {
  const now = options.now ?? Date.now;
  const timer = setInterval(() => {
    if (options.paused?.()) return;
    const poll = shouldSafetyPoll({
      status: options.status(),
      working: options.working(),
      lastEventAt: options.lastEventAt(),
      pollFailed: options.pollFailed?.() ?? false,
      now: now(),
      quietMs: options.quietMs,
    });
    if (poll) options.reload();
  }, options.tickMs ?? SAFETY_POLL_TICK_MS);
  return () => clearInterval(timer);
}

/**
 * Sem servidor a tela mostrava um texto vermelho solto ("Network request failed"). Isto
 * reconhece as falhas de rede — as do `fetch`, as que o próprio `apiFetch` traduz e os 5xx
 * do proxy — para a tela falar em português e no lugar certo.
 */
export function isConnectionProblem(message: string | null | undefined): boolean {
  if (!message) return false;
  return isTransientNetworkMessage(message);
}

export const CONNECTION_PROBLEM_MESSAGE =
  "Sem contato com o seu Quibt. Confira a conexão e tente de novo.";

/**
 * Erro interno de compatibilidade do RPC. Ele é recuperável (o fio tenta de novo) e nunca
 * deve aparecer em inglês para quem abriu a conversa.
 */
export function isConversationSyncProblem(message: string | null | undefined): boolean {
  return Boolean(message && /output validation failed/i.test(message));
}

export const CONVERSATION_SYNC_PROBLEM_MESSAGE =
  "A conversa está sincronizando. Tentando novamente…";

/** A mensagem que a pessoa lê: rede caída vira uma frase nossa; o resto passa como veio. */
export function userFacingError(error: unknown, fallback: string): string {
  const message = error instanceof Error && error.message ? error.message : fallback;
  if (isConnectionProblem(message)) return CONNECTION_PROBLEM_MESSAGE;
  if (isConversationSyncProblem(message)) return CONVERSATION_SYNC_PROBLEM_MESSAGE;
  return message;
}

/**
 * Quanto tempo o fio precisa passar em `reconnecting` por causa de um socket mudo antes de
 * valer o aviso. Num proxy que bufferiza o SSE o vigia derruba o socket a cada ~16 s e a
 * volta leva cerca de um segundo: piscar "Reconectando…" nesse ciclo assusta sem motivo.
 */
export const RECONNECTING_CHIP_DELAY_MS = 3_000;

/**
 * O chip discreto sob o cabeçalho. `offline` é o feed já ter desistido algumas vezes: aí
 * vale dizer que o Quibt pode estar desligado. Um poll que falhou por rede, com o fio ainda
 * de pé, é só "reconectando" — o feed vai perceber e trocar de estado sozinho.
 */
export function connectionChipLabel(input: {
  status: LiveFeedStatus;
  pollFailed: boolean;
  /**
   * A reconexão já dura o bastante para valer o aviso. `false` só enquanto o fio caiu por
   * silêncio do socket (o proxy segurando o SSE) e ainda cabe uma volta calada.
   */
  reconnectingSettled?: boolean;
}): string | null {
  if (input.status === "offline") return "Sem contato com o seu Quibt";
  if (input.status === "reconnecting") {
    return (input.reconnectingSettled ?? true) ? "Reconectando…" : null;
  }
  return input.pollFailed ? "Reconectando…" : null;
}
