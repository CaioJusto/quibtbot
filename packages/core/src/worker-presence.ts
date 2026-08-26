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

/**
 * O erro que a pessoa lê no lugar do silêncio. Sem jargão: quem instala não sabe o que é
 * "worker", e o CLI não tem `restart` — na VPS o caminho é o do Compose.
 */
export const WORKER_DOWN_MESSAGE =
  "A parte do Quibt que executa os bots parou. Reinicie o Quibt Bot (no computador: feche e abra o app; na VPS: docker compose restart) e mande a mensagem de novo.";

export interface WorkerPresence {
  /** Algum worker foi visto há menos de `WORKER_ALIVE_MS`. */
  alive: boolean;
  /** O batimento mais recente, ISO; `null` quando nunca houve worker. */
  lastSeenAt: string | null;
}

/**
 * O que a leitura do batimento respondeu. `null` é "a consulta respondeu vazio: nunca houve
 * worker"; `unknown` é "a consulta falhou" (banco fora, tabela não migrada) — e não saber
 * não é a mesma coisa que não haver worker: em `unknown` nada é reprovado.
 */
export type WorkerSeen = Date | null | { kind: "unknown" };

export const WORKER_SEEN_UNKNOWN: WorkerSeen = { kind: "unknown" };

export function workerSeenUnknown(seen: WorkerSeen | undefined): seen is { kind: "unknown" } {
  return typeof seen === "object" && seen !== null && "kind" in seen;
}

/** A resposta de `/health` e de `me`: vivo ou não, e quando foi visto pela última vez. */
export function workerPresence(
  lastSeenAt: WorkerSeen | undefined,
  now: Date = new Date(),
): WorkerPresence {
  if (!lastSeenAt || workerSeenUnknown(lastSeenAt)) return { alive: false, lastSeenAt: null };
  return {
    alive: now.getTime() - lastSeenAt.getTime() < WORKER_ALIVE_MS,
    lastSeenAt: lastSeenAt.toISOString(),
  };
}

/**
 * Nenhum worker há mais de `WORKER_GONE_MS` (ou nunca): a fila não anda. Uma leitura que
 * falhou não conta como sumido — um worker vivo com a API sem enxergar a tabela não pode
 * ter os runs destruídos por isso.
 */
export function workerGone(lastSeenAt: WorkerSeen | undefined, now: Date = new Date()): boolean {
  if (workerSeenUnknown(lastSeenAt)) return false;
  if (!lastSeenAt) return true;
  return now.getTime() - lastSeenAt.getTime() > WORKER_GONE_MS;
}

/**
 * A API acabou de subir. No Compose o worker só parte depois do healthcheck dela, e o último
 * batimento no banco é de antes da parada — pelos prazos, "sumido". Enquanto não passou o
 * tempo de um worker sumir de verdade, a leitura não vale para reprovar nada.
 */
export function workerMayBeBooting(
  apiStartedAt: Date | undefined,
  now: Date = new Date(),
): boolean {
  if (!apiStartedAt) return false;
  return now.getTime() - apiStartedAt.getTime() < WORKER_GONE_MS;
}

/**
 * Um run `queued` há mais de `QUEUED_RUN_PATIENCE_MS` sem worker por perto está abandonado:
 * é para virar `failed` com `WORKER_DOWN_MESSAGE`. Os dois prazos são independentes de
 * propósito — um worker que acabou de reiniciar ainda pega a fila, e um run recém-criado
 * não vira erro só porque o worker demorou um batimento.
 */
export function queuedRunAbandoned(input: {
  queuedAt: Date;
  workerSeenAt: WorkerSeen | undefined;
  now?: Date;
}): boolean {
  const now = input.now ?? new Date();
  if (now.getTime() - input.queuedAt.getTime() <= QUEUED_RUN_PATIENCE_MS) return false;
  return workerGone(input.workerSeenAt, now);
}

/**
 * Um run `leased`/`running` cujo lease venceu há mais de `WORKER_GONE_MS` e sem worker por
 * perto é o caso mais comum de worker morto: caiu no meio do trabalho. O reaper que
 * reenfileiraria o run roda no próprio worker — então quem resolve é a API.
 */
export function leasedRunAbandoned(input: {
  leaseExpiresAt: Date | null | undefined;
  workerSeenAt: WorkerSeen | undefined;
  now?: Date;
}): boolean {
  const now = input.now ?? new Date();
  if (!input.leaseExpiresAt) return false;
  if (now.getTime() - input.leaseExpiresAt.getTime() <= WORKER_GONE_MS) return false;
  return workerGone(input.workerSeenAt, now);
}

/**
 * O run que o snapshot acabou de ler merece uma olhada do reconciliador? É o filtro barato
 * antes de perguntar pelo batimento: fila velha, ou lease vencido há tempo demais.
 */
export function runLooksStranded(
  run: { status: string; updatedAt: Date; leaseExpiresAt?: Date | null },
  now: Date = new Date(),
): boolean {
  if (run.status === "queued") {
    return now.getTime() - run.updatedAt.getTime() > QUEUED_RUN_PATIENCE_MS;
  }
  if (run.status === "leased" || run.status === "running") {
    if (!run.leaseExpiresAt) return false;
    return now.getTime() - run.leaseExpiresAt.getTime() > WORKER_GONE_MS;
  }
  return false;
}
