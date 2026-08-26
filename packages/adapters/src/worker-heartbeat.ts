import type { NotificationProvider } from "@quibt/adapter-kit";
import {
  leasedRunAbandoned,
  QUEUED_RUN_PATIENCE_MS,
  queuedRunAbandoned,
  WORKER_DOWN_MESSAGE,
  WORKER_GONE_MS,
  WORKER_HEARTBEAT_MS,
  WORKER_SEEN_UNKNOWN,
  type WorkerSeen,
  workerMayBeBooting,
  workerSeenUnknown,
} from "@quibt/core";
import type { PrismaClient } from "@quibt/db";
import { appendEvent, appendThreadMessage } from "@quibt/db";

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

const LEASED = ["leased", "running"];

export interface FailRunsWithoutWorkerDeps {
  prisma: PrismaClient;
  /** A leitura do batimento; sem ela, lê direto do banco (e uma falha vira "não sei"). */
  workerSeenAt?: () => Promise<WorkerSeen>;
  /** Quando a API subiu: enquanto o worker pode estar vindo atrás dela, nada é reprovado. */
  apiStartedAt?: Date;
  /** O push do celular; só dispara para bots com `notifyOnFinish`. */
  notifications?: NotificationProvider;
}

interface StrandedRun {
  id: string;
  status: string;
  taskId: string;
  workspaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  leaseFence: number;
  leaseExpiresAt: Date | null;
  updatedAt: Date;
}

/**
 * O reconciliador leve da API. `reapExpiredLeases` roda no próprio worker — então um worker
 * que nunca subiu (ou que caiu no meio de um run) nunca toca em nada. Aqui a API pega os
 * runs parados em `queued` há mais de `QUEUED_RUN_PATIENCE_MS` e os `leased`/`running` com
 * lease vencido há mais de `WORKER_GONE_MS`; se nenhum worker deu sinal há mais de
 * `WORKER_GONE_MS`, marca cada um como `failed` com a frase que diz o que fazer — e leva a
 * frase até a pessoa: mensagem no fio e push no celular.
 *
 * `updatedAt` é o "está na fila desde": um run reenfileirado pelo reaper conta de novo. A
 * leitura do batimento em "não sei" e a API recém-subida não reprovam ninguém.
 */
export async function failRunsWithoutWorker(
  deps: FailRunsWithoutWorkerDeps,
  options?: { now?: Date; botId?: string; limit?: number },
): Promise<string[]> {
  const now = options?.now ?? new Date();
  if (workerMayBeBooting(deps.apiStartedAt, now)) return [];
  const queuedBefore = new Date(now.getTime() - QUEUED_RUN_PATIENCE_MS);
  const leaseGoneBefore = new Date(now.getTime() - WORKER_GONE_MS);
  const stale: StrandedRun[] = await deps.prisma.run.findMany({
    where: {
      ...(options?.botId ? { botId: options.botId } : {}),
      OR: [
        { status: "queued", updatedAt: { lt: queuedBefore } },
        { status: { in: LEASED }, leaseExpiresAt: { lt: leaseGoneBefore } },
      ],
    },
    select: {
      id: true,
      status: true,
      taskId: true,
      workspaceId: true,
      threadId: true,
      botId: true,
      userId: true,
      leaseFence: true,
      leaseExpiresAt: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "asc" },
    take: options?.limit ?? 50,
  });
  if (stale.length === 0) return [];
  const workerSeenAt = await (
    deps.workerSeenAt ??
    (() => lastWorkerSeenAt(deps.prisma).catch((): WorkerSeen => WORKER_SEEN_UNKNOWN))
  )();
  if (workerSeenUnknown(workerSeenAt)) return [];
  const failed: string[] = [];
  for (const run of stale) {
    const abandoned =
      run.status === "queued"
        ? queuedRunAbandoned({ queuedAt: run.updatedAt, workerSeenAt, now })
        : leasedRunAbandoned({ leaseExpiresAt: run.leaseExpiresAt, workerSeenAt, now });
    if (!abandoned) continue;
    const done = await deps.prisma.run.updateMany({
      where: { id: run.id, status: run.status, leaseFence: run.leaseFence },
      data: {
        status: "failed",
        error: WORKER_DOWN_MESSAGE,
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    if (done.count !== 1) continue;
    if (run.status !== "queued") {
      await deps.prisma.attempt
        .updateMany({
          where: { runId: run.id, fence: run.leaseFence, status: "running" },
          data: { status: "abandoned", finishedAt: now, error: WORKER_DOWN_MESSAGE },
        })
        .catch(() => undefined);
    }
    await deps.prisma.task
      .update({ where: { id: run.taskId }, data: { status: "failed" } })
      .catch(() => undefined);
    await announceWorkerDown(deps, run).catch(() => undefined);
    failed.push(run.id);
  }
  return failed;
}

/**
 * A frase precisa chegar onde a pessoa está olhando: uma mensagem `system` no fio (é o que
 * web e celular já desenham), o evento `run.failed` que apaga o "trabalhando", e o push do
 * celular para quem deixou o bot avisar quando termina. Cada perna falha sozinha: um push
 * que não sai não segura a mensagem.
 */
async function announceWorkerDown(deps: FailRunsWithoutWorkerDeps, run: StrandedRun) {
  const bot = await deps.prisma.bot
    .findUnique({
      where: { id: run.botId },
      select: { name: true, notifyOnFinish: true, activeConversationId: true },
    })
    .catch(() => null);
  const conversation = bot?.activeConversationId
    ? await deps.prisma.conversation
        .findUnique({ where: { id: bot.activeConversationId } })
        .catch(() => null)
    : null;
  const blocks = [{ kind: "text" as const, text: WORKER_DOWN_MESSAGE }];
  try {
    const message = await appendThreadMessage(deps.prisma, {
      threadId: run.threadId,
      role: "system",
      blocks,
      runId: run.id,
      conversationId: conversation?.id,
      parentId: conversation?.activeLeafId,
    });
    await appendEvent(deps.prisma, {
      workspaceId: run.workspaceId,
      threadId: run.threadId,
      botId: run.botId,
      type: "thread.message.created",
      runId: run.id,
      payload: { messageId: message.id, role: "system", blocks },
    });
  } catch {
    // Sem a mensagem ainda vale o evento abaixo: o "trabalhando" some e o erro fica no run.
  }
  await appendEvent(deps.prisma, {
    workspaceId: run.workspaceId,
    threadId: run.threadId,
    botId: run.botId,
    type: "run.failed",
    runId: run.id,
    payload: { error: WORKER_DOWN_MESSAGE },
  }).catch(() => undefined);
  if (!deps.notifications || !bot?.notifyOnFinish) return;
  await deps.notifications
    .send(
      {
        kind: "failure",
        title: `${bot.name} parou de responder`,
        body: WORKER_DOWN_MESSAGE,
        botId: run.botId,
        threadId: run.threadId,
      },
      {
        operationId: "notify",
        traceId: run.botId,
        workspaceId: run.workspaceId,
        userId: run.userId,
        botId: run.botId,
        signal: new AbortController().signal,
      },
    )
    .catch(() => undefined);
}
