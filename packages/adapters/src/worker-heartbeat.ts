import {
  QUEUED_RUN_PATIENCE_MS,
  queuedRunAbandoned,
  WORKER_DOWN_MESSAGE,
  WORKER_HEARTBEAT_MS,
} from "@quibt/core";
import type { PrismaClient } from "@quibt/db";
import { appendEvent } from "@quibt/db";

/** Linhas de workers sumidos há mais de uma hora são lixo: ficam só os vivos e os recém-mortos. */
const STALE_HEARTBEAT_MS = 60 * 60_000;

/** Um batimento: cria a linha do worker na primeira vez e só avança `seenAt` nas seguintes. */
export async function recordWorkerHeartbeat(
  prisma: PrismaClient,
  input: { workerId: string; version: string; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  await prisma.workerHeartbeat.upsert({
    where: { id: input.workerId },
    create: { id: input.workerId, version: input.version, startedAt: now, seenAt: now },
    update: { seenAt: now, version: input.version },
  });
  await prisma.workerHeartbeat
    .deleteMany({ where: { seenAt: { lt: new Date(now.getTime() - STALE_HEARTBEAT_MS) } } })
    .catch(() => undefined);
}

/** O batimento mais recente entre todos os workers; `null` quando nunca houve um. */
export async function lastWorkerSeenAt(prisma: PrismaClient): Promise<Date | null> {
  const row = await prisma.workerHeartbeat.findFirst({
    orderBy: { seenAt: "desc" },
    select: { seenAt: true },
  });
  return row?.seenAt ?? null;
}

export interface WorkerHeartbeatLoop {
  /** Um batimento agora; exposto para os testes não dependerem do relógio. */
  beat(): Promise<void>;
  stop(): void;
}

/**
 * O laço do worker: bate uma vez já e depois a cada `WORKER_HEARTBEAT_MS`. Um banco fora do
 * ar não derruba o worker — o erro vai para `onError` e o próximo batimento tenta de novo.
 * O timer é `unref`: o batimento nunca segura um processo que já está indo embora.
 */
export function startWorkerHeartbeat(
  prisma: PrismaClient,
  input: {
    workerId: string;
    version: string;
    intervalMs?: number;
    onError?: (error: unknown) => void;
  },
): WorkerHeartbeatLoop {
  let stopped = false;
  const beat = async () => {
    if (stopped) return;
    try {
      await recordWorkerHeartbeat(prisma, { workerId: input.workerId, version: input.version });
    } catch (error) {
      input.onError?.(error);
    }
  };
  const timer = setInterval(() => {
    void beat();
  }, input.intervalMs ?? WORKER_HEARTBEAT_MS);
  timer.unref?.();
  void beat();
  return {
    beat,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * O reconciliador leve da API. `reapExpiredLeases` só cuida de `leased`/`running` — e roda no
 * próprio worker, então um worker que nunca subiu nunca toca em nada. Aqui a API pega os runs
 * parados em `queued` há mais de `QUEUED_RUN_PATIENCE_MS`, e, se nenhum worker deu sinal há
 * mais de `WORKER_GONE_MS`, marca cada um como `failed` com a frase que diz o que fazer.
 * `updatedAt` é o "está na fila desde": um run reenfileirado pelo reaper conta de novo.
 */
export async function failRunsQueuedWithoutWorker(
  deps: { prisma: PrismaClient; workerSeenAt?: () => Promise<Date | null> },
  options?: { now?: Date; botId?: string; limit?: number },
): Promise<string[]> {
  const now = options?.now ?? new Date();
  const queuedBefore = new Date(now.getTime() - QUEUED_RUN_PATIENCE_MS);
  const stale = await deps.prisma.run.findMany({
    where: {
      status: "queued",
      updatedAt: { lt: queuedBefore },
      ...(options?.botId ? { botId: options.botId } : {}),
    },
    select: {
      id: true,
      taskId: true,
      workspaceId: true,
      threadId: true,
      botId: true,
      leaseFence: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "asc" },
    take: options?.limit ?? 50,
  });
  if (stale.length === 0) return [];
  const workerSeenAt = await (deps.workerSeenAt ?? (() => lastWorkerSeenAt(deps.prisma)))();
  const failed: string[] = [];
  for (const run of stale) {
    if (!queuedRunAbandoned({ queuedAt: run.updatedAt, workerSeenAt, now })) continue;
    const done = await deps.prisma.run.updateMany({
      where: { id: run.id, status: "queued", leaseFence: run.leaseFence },
      data: { status: "failed", error: WORKER_DOWN_MESSAGE, completedAt: now },
    });
    if (done.count !== 1) continue;
    await deps.prisma.task
      .update({ where: { id: run.taskId }, data: { status: "failed" } })
      .catch(() => undefined);
    await appendEvent(deps.prisma, {
      workspaceId: run.workspaceId,
      threadId: run.threadId,
      botId: run.botId,
      type: "run.failed",
      runId: run.id,
      payload: { error: WORKER_DOWN_MESSAGE },
    }).catch(() => undefined);
    failed.push(run.id);
  }
  return failed;
}
