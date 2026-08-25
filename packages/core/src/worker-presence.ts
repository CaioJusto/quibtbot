/**
 * Presença do worker: o processo que executa os runs grava um batimento no banco a cada
 * `WORKER_HEARTBEAT_MS`. A API só sabe que existe alguém para pegar a fila por esse sinal.
 * Sem ele, um worker que não subiu (ou caiu) era silêncio: a pessoa mandava mensagem, o
 * run ficava `queued` para sempre e a bolinha verde dizia "trabalhando".
 */

/** De quanto em quanto tempo o worker passa no banco. */
export const WORKER_HEARTBEAT_MS = 15_000;
/** Visto há menos que isto: vivo. Quatro batimentos de folga para um GC ou um banco lento. */
export const WORKER_ALIVE_MS = 60_000;
/** Sem sinal há mais que isto, um run parado na fila não tem quem o pegue. */
export const WORKER_GONE_MS = 90_000;
/** Quanto tempo um run pode esperar na fila antes de a falta de worker virar erro. */
export const QUEUED_RUN_PATIENCE_MS = 120_000;
/** De quanto em quanto tempo a API varre a fila atrás de runs abandonados. */
export const QUEUED_RUN_RECONCILE_MS = 30_000;

/** O erro que a pessoa lê no lugar do silêncio. */
export const WORKER_DOWN_MESSAGE =
  "O worker do Quibt não está rodando. Reinicie o Quibt Bot (ou o Docker) e mande de novo.";

export interface WorkerPresence {
  /** Algum worker foi visto há menos de `WORKER_ALIVE_MS`. */
  alive: boolean;
  /** O batimento mais recente, ISO; `null` quando nunca houve worker. */
  lastSeenAt: string | null;
}

/** A resposta de `/health` e de `me`: vivo ou não, e quando foi visto pela última vez. */
export function workerPresence(
  lastSeenAt: Date | null | undefined,
  now: Date = new Date(),
): WorkerPresence {
  if (!lastSeenAt) return { alive: false, lastSeenAt: null };
  return {
    alive: now.getTime() - lastSeenAt.getTime() < WORKER_ALIVE_MS,
    lastSeenAt: lastSeenAt.toISOString(),
  };
}

/** Nenhum worker há mais de `WORKER_GONE_MS` (ou nunca): a fila não anda. */
export function workerGone(lastSeenAt: Date | null | undefined, now: Date = new Date()): boolean {
  if (!lastSeenAt) return true;
  return now.getTime() - lastSeenAt.getTime() > WORKER_GONE_MS;
}

/**
 * Um run `queued` há mais de `QUEUED_RUN_PATIENCE_MS` sem worker por perto está abandonado:
 * é para virar `failed` com `WORKER_DOWN_MESSAGE`. Os dois prazos são independentes de
 * propósito — um worker que acabou de reiniciar ainda pega a fila, e um run recém-criado
 * não vira erro só porque o worker demorou um batimento.
 */
export function queuedRunAbandoned(input: {
  queuedAt: Date;
  workerSeenAt: Date | null | undefined;
  now?: Date;
}): boolean {
  const now = input.now ?? new Date();
  if (now.getTime() - input.queuedAt.getTime() <= QUEUED_RUN_PATIENCE_MS) return false;
  return workerGone(input.workerSeenAt, now);
}
