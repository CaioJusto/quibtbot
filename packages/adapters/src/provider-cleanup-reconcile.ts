import type {
  AdapterContext,
  ComputerRef,
  SandboxProvider,
  WakeupDriver,
} from "@quibt/adapter-kit";
import type { PrismaClient } from "@quibt/db";
import { finalizeBotDestroyAfterProvider } from "./bot-destroy-finalize.js";
import {
  cancelBootOrphanIntent,
  cancelLifecycleCleanupIntent,
  finalizeLifecycleStopAfterProvider,
  isBootOrphanRefActive,
  isBootOrphanRow,
  isLifecycleCleanupRow,
  type LifecycleIntentRow,
  lifecycleContextFromRow,
  refFromLifecycleRow,
  resolveBootOrphanIntent,
  resolveLifecycleCleanupIntent,
  validateLifecycleCleanupIntent,
} from "./lifecycle-cleanup-intent.js";
import { destroyBotSessionForRef, shouldPreserveSharedComputer } from "./sandbox-destroy.js";
import {
  claimComputerSessionStartGate,
  type ProviderCleanupAction,
  releaseComputerSessionStartGate,
  startComputerSessionGateHeartbeat,
  validateComputerSessionStartGate,
  withComputerSessionGate,
} from "./session-lifecycle.js";
import { isWorkspaceScopedSandbox, sharedComputerSiblingActivity } from "./workspace-computer.js";

export const DEFAULT_ORPHAN_RECONCILE_BATCH = 10;
export const ORPHAN_RECONCILE_INTERVAL_MS = 5 * 60_000;
export const SESSION_GATE_WAIT_MS = 5_000;

export function isProviderCleanupIntent(row: {
  lifecycleAction?: string | null;
  reason: string;
}): boolean {
  return isLifecycleCleanupRow(row as LifecycleIntentRow);
}

export function cleanupActionFromRow(row: LifecycleIntentRow): ProviderCleanupAction | null {
  if (row.lifecycleAction === "stop:idle" || row.lifecycleAction === "destroy:delete") {
    return row.lifecycleAction;
  }
  return null;
}

function reconcileContext(workspaceId: string, botId: string | null): AdapterContext {
  return {
    operationId: "orphan.reconcile",
    traceId: "orphan.reconcile",
    workspaceId,
    userId: "system",
    botId: botId ?? undefined,
    signal: new AbortController().signal,
  };
}

async function reconcileBootOrphanIntent(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider },
  row: LifecycleIntentRow,
): Promise<"resolved" | "pending" | "cancelled"> {
  if (
    await isBootOrphanRefActive(deps.prisma, {
      workspaceId: row.workspaceId,
      kind: row.provider,
      providerRef: row.providerRef,
    })
  ) {
    await cancelBootOrphanIntent(deps.prisma, {
      workspaceId: row.workspaceId,
      provider: row.provider,
      providerRef: row.providerRef,
      reason: "boot orphan ref still active",
    });
    return "cancelled";
  }
  const ref: ComputerRef = {
    id: row.providerRef,
    botId: row.botId ?? "workspace",
    kind: row.provider as ComputerRef["kind"],
    providerRef: row.providerRef,
  };
  const ctx = reconcileContext(row.workspaceId, row.botId);
  try {
    await deps.sandbox.destroy(ref, ctx);
    await resolveBootOrphanIntent(deps.prisma, {
      workspaceId: row.workspaceId,
      provider: row.provider,
      providerRef: row.providerRef,
    });
    return "resolved";
  } catch {
    return "pending";
  }
}

async function reconcileLifecycleIntent(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    home?: import("@quibt/adapter-kit").AgentHomeStore;
    dataDir?: string;
  },
  row: LifecycleIntentRow,
): Promise<"resolved" | "pending" | "cancelled"> {
  const validation = await validateLifecycleCleanupIntent(deps.prisma, row);
  if (!validation.ok) {
    if (validation.reason === "reactivated" || validation.reason === "stale") {
      await cancelLifecycleCleanupIntent(deps.prisma, {
        workspaceId: row.workspaceId,
        sessionBotId: row.sessionBotId!,
        lifecycleToken: row.lifecycleToken!,
        lifecycleAction:
          row.lifecycleAction === "stop:idle" || row.lifecycleAction === "destroy:delete"
            ? row.lifecycleAction
            : "stop:idle",
        reason: `lifecycle intent ${validation.reason}`,
      });
      return "cancelled";
    }
    return "pending";
  }

  const ctx = lifecycleContextFromRow(row);
  if (!ctx) return "pending";

  const ref = refFromLifecycleRow(row);
  const adapterCtx = reconcileContext(row.workspaceId, ctx.sessionBotId);
  const session = await deps.prisma.desktopSession.findUnique({
    where: { botId: ctx.sessionBotId },
    include: { computer: true },
  });
  if (!session) return "pending";

  const shared = isWorkspaceScopedSandbox(session.computer.kind);

  try {
    if (validation.action === "stop:idle") {
      if (shared) {
        const gated = await withComputerSessionGate(deps.prisma, row.workspaceId, async () => {
          if (!(await validateLifecycleCleanupIntent(deps.prisma, row)).ok) {
            throw new Error("lost suspend claim");
          }
          await deps.sandbox.stop(ref, adapterCtx);
        });
        if (!gated.ok) return "pending";
      } else {
        await deps.sandbox.stop(ref, adapterCtx);
      }
      const finalized = await finalizeLifecycleStopAfterProvider(deps.prisma, {
        sessionBotId: ctx.sessionBotId,
        lifecycleToken: ctx.lifecycleToken,
      });
      if (!finalized) return "pending";
      await resolveLifecycleCleanupIntent(deps.prisma, {
        workspaceId: row.workspaceId,
        sessionBotId: ctx.sessionBotId,
        lifecycleAction: "stop:idle",
        lifecycleToken: ctx.lifecycleToken,
      });
      return "resolved";
    }

    let sessionGate: { token: string } | null = null;
    let stopHeartbeat: (() => void) | undefined;
    let finalized = false;
    if (shared) {
      sessionGate = await claimComputerSessionStartGate(deps.prisma, row.workspaceId);
      if (!sessionGate) return "pending";
      stopHeartbeat = startComputerSessionGateHeartbeat(
        deps.prisma,
        row.workspaceId,
        sessionGate.token,
      );
    }

    try {
      const activity = await sharedComputerSiblingActivity(deps.prisma, {
        computerId: session.computerId,
        workspaceId: row.workspaceId,
        botId: ctx.sessionBotId,
      });
      const preserveComputer = shouldPreserveSharedComputer(session.computer.kind, activity);

      if (
        sessionGate &&
        !(await validateComputerSessionStartGate(deps.prisma, row.workspaceId, sessionGate.token))
      ) {
        return "pending";
      }
      if (!(await validateLifecycleCleanupIntent(deps.prisma, row)).ok) {
        return "pending";
      }

      await destroyBotSessionForRef(deps.sandbox, ref, adapterCtx, { preserveComputer });

      if (!deps.home) return "pending";
      finalized = await finalizeBotDestroyAfterProvider(
        { prisma: deps.prisma, home: deps.home, dataDir: deps.dataDir },
        {
          botId: ctx.sessionBotId,
          workspaceId: row.workspaceId,
          claimToken: ctx.lifecycleToken,
          restoreState: "stopped",
          computer: { id: session.computer.id, kind: session.computer.kind },
          sessionGateToken: sessionGate?.token ?? null,
        },
      );
      if (!finalized) return "pending";

      await resolveLifecycleCleanupIntent(deps.prisma, {
        workspaceId: row.workspaceId,
        sessionBotId: ctx.sessionBotId,
        lifecycleAction: "destroy:delete",
        lifecycleToken: ctx.lifecycleToken,
      });
      return "resolved";
    } finally {
      stopHeartbeat?.();
      if (sessionGate && !finalized) {
        await releaseComputerSessionStartGate(deps.prisma, row.workspaceId, sessionGate.token);
      }
    }
  } catch {
    return "pending";
  }
}

/** Retries a single pending cleanup intent when present (idempotent). */
export async function reconcileProviderCleanupIntent(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    home?: import("@quibt/adapter-kit").AgentHomeStore;
    dataDir?: string;
  },
  input: {
    workspaceId: string;
    sessionBotId?: string | null;
    lifecycleAction?: ProviderCleanupAction | null;
    provider?: string;
    providerRef?: string;
  },
): Promise<"resolved" | "pending" | "absent" | "cancelled"> {
  let row: LifecycleIntentRow | null = null;

  if (input.sessionBotId && input.lifecycleAction) {
    row = (await deps.prisma.orphanProvision.findFirst({
      where: {
        workspaceId: input.workspaceId,
        sessionBotId: input.sessionBotId,
        lifecycleAction: input.lifecycleAction,
      },
    })) as LifecycleIntentRow | null;
  } else if (input.provider && input.providerRef) {
    row = (await deps.prisma.orphanProvision.findFirst({
      where: {
        workspaceId: input.workspaceId,
        provider: input.provider,
        providerRef: input.providerRef,
        lifecycleAction: null,
        status: "pending",
      },
    })) as LifecycleIntentRow | null;
  }

  if (row?.status !== "pending") return "absent";

  if (isLifecycleCleanupRow(row)) {
    const outcome = await reconcileLifecycleIntent(deps, row);
    if (outcome === "resolved") return "resolved";
    if (outcome === "cancelled") return "cancelled";
    return "pending";
  }

  if (isBootOrphanRow(row)) {
    const outcome = await reconcileBootOrphanIntent(deps, row);
    if (outcome === "resolved") return "resolved";
    if (outcome === "cancelled") return "cancelled";
    return "pending";
  }

  return "absent";
}

/** Bounded batch reconciler for pending stop/destroy intents. */
export async function reconcilePendingProviderCleanups(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    home?: import("@quibt/adapter-kit").AgentHomeStore;
    dataDir?: string;
  },
  options?: { limit?: number; workspaceId?: string; botId?: string },
): Promise<number> {
  const rows = (await deps.prisma.orphanProvision.findMany({
    where: {
      status: "pending",
      ...(options?.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(options?.botId ? { botId: options.botId } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: options?.limit ?? DEFAULT_ORPHAN_RECONCILE_BATCH,
  })) as LifecycleIntentRow[];

  let resolved = 0;
  for (const row of rows) {
    const outcome = await reconcileProviderCleanupIntent(deps, {
      workspaceId: row.workspaceId,
      sessionBotId: row.sessionBotId,
      lifecycleAction:
        row.lifecycleAction === "stop:idle" || row.lifecycleAction === "destroy:delete"
          ? row.lifecycleAction
          : null,
      provider: row.provider,
      providerRef: row.providerRef,
    });
    if (outcome === "resolved") resolved += 1;
  }
  return resolved;
}

export function scheduleOrphanReconcile(
  wakeup: WakeupDriver | undefined,
  delayMs = ORPHAN_RECONCILE_INTERVAL_MS,
): void {
  if (!wakeup) return;
  void wakeup
    .enqueue({
      name: "orphan.reconcile",
      payload: {},
      runAt: new Date(Date.now() + delayMs),
      jobKey: "orphan.reconcile",
    })
    .catch((error) => console.error("orphan.reconcile", error));
}
