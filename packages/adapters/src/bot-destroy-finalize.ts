import { rm } from "node:fs/promises";
import type { AgentHomeStore } from "@quibt/adapter-kit";
import { closeComputerUsage, type PrismaClient } from "@quibt/db";
import { resolveAgentHomePath } from "./home.js";
import {
  releaseComputerSessionStartGate,
  releaseDesktopDeleteClaim,
  renewDesktopDeleteClaim,
} from "./session-lifecycle.js";
import {
  isWorkspaceScopedSandbox,
  sharedComputerSiblingActivity,
  shouldStopSharedComputer,
} from "./workspace-computer.js";

export type BotDestroyFinalizeInput = {
  botId: string;
  workspaceId: string;
  claimToken: string;
  restoreState: string;
  computer?: {
    id: string;
    kind: string;
  } | null;
  sessionGateToken?: string | null;
  dataDir?: string;
};

/** Clears shared computer refs when no siblings remain; releases gate only after clear. */
export async function maybeStopSharedComputerAfterDestroy(
  prisma: PrismaClient,
  input: {
    computerId: string;
    workspaceId: string;
    botId: string;
    kind: string;
    computerIdForUpdate: string;
    sessionGateToken?: string | null;
  },
): Promise<void> {
  const activity = await sharedComputerSiblingActivity(prisma, {
    computerId: input.computerId,
    workspaceId: input.workspaceId,
    botId: input.botId,
  });
  if (
    !shouldStopSharedComputer({
      kind: input.kind,
      ...activity,
      userHoldsControl: false,
    })
  ) {
    if (input.sessionGateToken) {
      await releaseComputerSessionStartGate(prisma, input.workspaceId, input.sessionGateToken);
    }
    return;
  }
  await prisma.$transaction(async (tx) => {
    await tx.computer.updateMany({
      where: {
        id: input.computerIdForUpdate,
        ...(input.sessionGateToken ? { bootClaimToken: input.sessionGateToken } : {}),
      },
      data: {
        providerRef: null,
        state: "stopped",
        bootClaimToken: null,
        bootClaimedAt: null,
      },
    });
  });
  if (input.sessionGateToken) {
    await releaseComputerSessionStartGate(prisma, input.workspaceId, input.sessionGateToken);
  }
}

/** Quantas linhas por lote: curto o bastante para não segurar a tabela nem o prazo. */
export const DESTROY_BATCH_SIZE = 500;

type BatchTarget = {
  find: (take: number) => Promise<{ id: string }[]>;
  remove: (ids: string[]) => Promise<{ count: number }>;
};

export type PurgeOptions = {
  /** Chamado depois de cada lote, para renovar a marca de exclusão que segura a sessão. */
  onBatch?: () => Promise<unknown>;
};

/** Esvazia uma tabela filha em lotes; cada lote é uma transação própria do banco. */
async function drain(
  target: BatchTarget,
  batchSize: number,
  options?: PurgeOptions,
): Promise<number> {
  let removed = 0;
  for (;;) {
    const rows = await target.find(batchSize);
    if (rows.length === 0) return removed;
    const deleted = await target.remove(rows.map((row) => row.id));
    // Achou linha e não apagou nenhuma: sair em vez de girar para sempre.
    if (deleted.count === 0) return removed;
    removed += deleted.count;
    await options?.onBatch?.();
  }
}

/**
 * Apaga em lotes o histórico pesado do bot, fora de qualquer transação nossa.
 *
 * São as duas tabelas que a medição apontou: runs (10 mil linhas por bot é comum) e as
 * tasks que as seguram. Eventos e mensagens saem baratos na cascata da thread e ficam de
 * fora. É retomável de propósito: se o processo morrer no meio, rodar de novo continua de
 * onde parou, e o que sobrou some junto com o bot na cascata. A ordem segue a dependência
 * (runs antes de tasks, que são as donas delas).
 */
export async function purgeBotHistoryInBatches(
  prisma: PrismaClient,
  botId: string,
  batchSize: number = DESTROY_BATCH_SIZE,
  options?: PurgeOptions,
): Promise<number> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError("destroy batch size must be a positive safe integer");
  }
  let removed = 0;
  removed += await drain(
    {
      find: (take) => prisma.run.findMany({ where: { botId }, select: { id: true }, take }),
      remove: (ids) => prisma.run.deleteMany({ where: { id: { in: ids } } }),
    },
    batchSize,
    options,
  );
  removed += await drain(
    {
      find: (take) => prisma.task.findMany({ where: { botId }, select: { id: true }, take }),
      remove: (ids) => prisma.task.deleteMany({ where: { id: { in: ids } } }),
    },
    batchSize,
    options,
  );
  return removed;
}

/**
 * Shared bot/session removal after provider destroy succeeds (normal path + reconciler).
 *
 * A marca de exclusão ("deleting" + token) e o providerRef da sessão ficam de pé até a
 * remoção FINAL da linha. Antes, a sessão era encerrada para "stopped" logo na entrada:
 * se um lote do histórico ou a transação final falhasse, a intent continuava pendente mas
 * a retomada era impossível — `validateLifecycleCleanupIntent` exige estado "deleting" com
 * o MESMO token, então o reconciliador classificava como "stale" e cancelava, deixando um
 * bot meio apagado. Agora cada passo é idempotente e a última coisa a sair é a própria
 * marca, apagada sob CAS dentro da transação final.
 */
export async function finalizeBotDestroyAfterProvider(
  deps: {
    prisma: PrismaClient;
    home: AgentHomeStore;
    dataDir?: string;
  },
  input: BotDestroyFinalizeInput,
): Promise<boolean> {
  // Valida E renova num único CAS. A chamada ao provedor pode ter levado quase todo o
  // prazo de stale; só consultar e começar o primeiro lote deixava outra exclusão roubar
  // a marca entre esses dois passos.
  const retained = await renewDesktopDeleteClaim(deps.prisma, input.botId, input.claimToken);
  if (!retained) {
    await releaseDesktopDeleteClaim(
      deps.prisma,
      input.botId,
      input.claimToken,
      input.restoreState as "running" | "suspended" | "stopped" | "error",
    );
    if (input.sessionGateToken) {
      await releaseComputerSessionStartGate(deps.prisma, input.workspaceId, input.sessionGateToken);
    }
    return false;
  }

  await closeComputerUsage(deps.prisma, input.botId);
  // O computador já foi destruído no provedor. Uma transação só, apagando anos de
  // histórico em cascata, passava do prazo do banco e era desfeita: o bot voltava vivo,
  // porém sem computador e sem conserto. O histórico pesado sai antes, em lotes curtos e
  // retomáveis, e a transação final fica com poucas linhas.
  await purgeBotHistoryInBatches(deps.prisma, input.botId, DESTROY_BATCH_SIZE, {
    onBatch: async () => {
      if (!(await renewDesktopDeleteClaim(deps.prisma, input.botId, input.claimToken))) {
        throw new Error("desktop delete claim lost during history purge");
      }
    },
  });

  const computer = input.computer;
  const removed = await deps.prisma.$transaction(async (tx) => {
    // Cerca final: a linha só sai se a marca ainda for nossa. Uma falha aqui desfaz a
    // transação inteira e deixa a sessão em "deleting" com o mesmo token, pronta para o
    // próximo retry da intent pendente.
    const fenced = await tx.desktopSession.deleteMany({
      where: { botId: input.botId, state: "deleting", bootClaimToken: input.claimToken },
    });
    if (fenced.count !== 1) return false;
    await tx.bot.delete({ where: { id: input.botId } });
    if (computer) {
      const sessions = await tx.desktopSession.count({
        where: { computerId: computer.id },
      });
      if (sessions === 0) {
        await tx.computer.delete({ where: { id: computer.id } }).catch(() => undefined);
      }
    }
    return true;
  });
  if (!removed) {
    if (input.sessionGateToken) {
      await releaseComputerSessionStartGate(deps.prisma, input.workspaceId, input.sessionGateToken);
    }
    return false;
  }

  if (computer && isWorkspaceScopedSandbox(computer.kind)) {
    await maybeStopSharedComputerAfterDestroy(deps.prisma, {
      computerId: computer.id,
      workspaceId: input.workspaceId,
      botId: input.botId,
      kind: computer.kind,
      computerIdForUpdate: computer.id,
      sessionGateToken: input.sessionGateToken,
    });
  } else if (input.sessionGateToken) {
    await releaseComputerSessionStartGate(deps.prisma, input.workspaceId, input.sessionGateToken);
  }

  await rm(resolveAgentHomePath(deps.home, input.botId, deps.dataDir ?? "./data"), {
    recursive: true,
    force: true,
  }).catch(() => undefined);

  return true;
}
