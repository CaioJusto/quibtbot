import { lastWorkerSeenAt } from "@quibt/adapters";
import type { WorkerPresence } from "@quibt/contracts";
import { WORKER_SEEN_UNKNOWN, type WorkerSeen, workerPresence } from "@quibt/core";
import type { PrismaClient } from "@quibt/db";

export interface WorkerPresenceReader {
  /** O batimento mais recente; agora mesmo quando a própria API executa os runs. */
  seenAt(): Promise<WorkerSeen>;
  /** Quando esta API subiu: o worker do Compose parte depois dela e demora a bater. */
  startedAt: Date;
  /** O que `/health` e `me` devolvem. */
  read(now?: Date): Promise<WorkerPresence>;
}

/**
 * A API lê o worker pelo batimento que ele deixa no banco. Com o driver de wakeup em memória
 * (`WAKEUP_DRIVER=memory`, o dos emuladores) não há processo separado: a própria API executa
 * os runs, então ela é o worker e está sempre viva.
 *
 * Uma leitura que falha (banco fora, tabela ainda não migrada) responde "não sei", não "nunca
 * houve worker": `/health` e `me` continuam dizendo `alive: false` — sem banco a fila também
 * não anda —, mas nada é reprovado por causa de uma pergunta que não foi respondida.
 */
export function createWorkerPresenceReader(input: {
  prisma: PrismaClient;
  inProcess: boolean;
  startedAt?: Date;
}): WorkerPresenceReader {
  const seenAt = async (): Promise<WorkerSeen> => {
    if (input.inProcess) return new Date();
    return lastWorkerSeenAt(input.prisma).catch((): WorkerSeen => WORKER_SEEN_UNKNOWN);
  };
  return {
    seenAt,
    startedAt: input.startedAt ?? new Date(),
    read: async (now = new Date()) => workerPresence(await seenAt(), now),
  };
}
