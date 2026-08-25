import { lastWorkerSeenAt } from "@quibt/adapters";
import type { WorkerPresence } from "@quibt/contracts";
import { workerPresence } from "@quibt/core";
import type { PrismaClient } from "@quibt/db";

export interface WorkerPresenceReader {
  /** O batimento mais recente; agora mesmo quando a própria API executa os runs. */
  seenAt(): Promise<Date | null>;
  /** O que `/health` e `me` devolvem. */
  read(now?: Date): Promise<WorkerPresence>;
}

/**
 * A API lê o worker pelo batimento que ele deixa no banco. Com o driver de wakeup em memória
 * (`WAKEUP_DRIVER=memory`, o dos emuladores) não há processo separado: a própria API executa
 * os runs, então ela é o worker e está sempre viva. Uma leitura que falha responde "morto"
 * em vez de derrubar `/health`: sem banco, a fila também não anda.
 */
export function createWorkerPresenceReader(input: {
  prisma: PrismaClient;
  inProcess: boolean;
}): WorkerPresenceReader {
  const seenAt = async (): Promise<Date | null> => {
    if (input.inProcess) return new Date();
    return lastWorkerSeenAt(input.prisma).catch(() => null);
  };
  return {
    seenAt,
    read: async (now = new Date()) => workerPresence(await seenAt(), now),
  };
}
