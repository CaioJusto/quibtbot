import type { AgentHomeStore, SandboxProvider, WakeupDriver } from "@quibt/adapter-kit";
import {
  reapExpiredLeases,
  reconcilePendingProviderCleanups,
  scheduleOrphanReconcile,
  scheduleRunReap,
  sleepComputerIfIdle,
} from "@quibt/adapters";
import { reapControl } from "@quibt/core";
import type { PrismaClient } from "@quibt/db";

export interface RunExecutorLike {
  continueRun(runId: string, workerId: string): Promise<void>;
  wakeRoutine(routineId: string, workerId: string): Promise<void>;
}

export interface WorkerHandlerDeps {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  wakeup: WakeupDriver;
  executor: RunExecutorLike;
  home?: AgentHomeStore;
  dataDir?: string;
  workerId?: string;
}

export type WakeupHandlers = Record<string, (payload: Record<string, unknown>) => Promise<void>>;

export function createWakeupHandlers(deps: WorkerHandlerDeps): WakeupHandlers {
  const workerId = deps.workerId ?? process.pid.toString();
  return {
    "run.continue": async (payload) => {
      await deps.executor.continueRun(String(payload.runId), workerId);
    },
    "routine.wakeup": async (payload) => {
      await deps.executor.wakeRoutine(String(payload.routineId), workerId);
    },
    "computer.sleep": async (payload) => {
      await sleepComputerIfIdle(
        { prisma: deps.prisma, sandbox: deps.sandbox, wakeup: deps.wakeup },
        String(payload.botId),
      );
    },
    // A takeover lease that nobody released has to end on its own, or the bot never gets its
    // computer back. Scheduled for the lease deadline by `computer.takeover`.
    "control.reap": async (payload) => {
      const botId = payload.botId ? String(payload.botId) : undefined;
      await reapControl({ db: deps.prisma, wakeup: deps.wakeup }, botId ? { botId } : {});
    },
    // A worker that dies mid-run leaves the row `running` until the Graphile lock expires
    // hours later. The reaper requeues those runs and always reschedules itself.
    "run.reap": async () => {
      try {
        await reapExpiredLeases({ prisma: deps.prisma, wakeup: deps.wakeup });
      } finally {
        scheduleRunReap(deps.wakeup);
      }
    },
    "orphan.reconcile": async () => {
      try {
        await reconcilePendingProviderCleanups({
          prisma: deps.prisma,
          sandbox: deps.sandbox,
          home: deps.home,
          dataDir: deps.dataDir,
        });
      } finally {
        scheduleOrphanReconcile(deps.wakeup);
      }
    },
  };
}
