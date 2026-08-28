import type {
  AdapterContext,
  ComputerRef,
  SandboxProvider,
  WakeupDriver,
} from "@quibt/adapter-kit";
import { controlLeaseLive } from "@quibt/core";
import type { PrismaClient } from "@quibt/db";
import { appendEvent, closeComputerUsage } from "@quibt/db";
import { computerRefFromSession } from "./computer-boot-claim.js";
import {
  recordLifecycleCleanupIntent,
  resolveLifecycleCleanupIntent,
} from "./lifecycle-cleanup-intent.js";
import { reconcileProviderCleanupIntent } from "./provider-cleanup-reconcile.js";
import { stopSandboxUnlessAlreadyGone } from "./sandbox-destroy.js";
import {
  claimDesktopSuspend,
  cleanupIntentReason,
  finalizeDesktopSuspended,
  recoverStaleDesktopSuspend,
  releaseDesktopSuspendClaim,
  validateDesktopSuspendClaim,
  withComputerSessionGate,
} from "./session-lifecycle.js";
import {
  ACTIVE_RUN_STATUSES,
  isWorkspaceScopedSandbox,
  sharedComputerSiblingActivity,
  shouldStopSharedComputer,
  workspaceProviderRef,
} from "./workspace-computer.js";

export const DEFAULT_SANDBOX_IDLE_MS = 10 * 60 * 1000;

export function sandboxIdleMs(): number {
  const raw = Number(process.env.SANDBOX_IDLE_MS ?? DEFAULT_SANDBOX_IDLE_MS);
  return Number.isFinite(raw) && raw >= 30_000 ? raw : DEFAULT_SANDBOX_IDLE_MS;
}

export function scheduleComputerSleep(wakeup: WakeupDriver | undefined, botId: string): void {
  if (!wakeup || !botId) return;
  void wakeup
    .enqueue({
      name: "computer.sleep",
      payload: { botId },
      runAt: new Date(Date.now() + sandboxIdleMs()),
      jobKey: `computer.sleep:${botId}`,
    })
    .catch((error) => console.error("computer.sleep", error));
}

export async function touchRunningComputer(
  deps: { sandbox: SandboxProvider; wakeup?: WakeupDriver },
  computer: {
    botId: string;
    providerRef: string;
    kind: string;
    display?: number;
    screenUrl?: string;
    workspaceId?: string;
    userId?: string;
  },
): Promise<void> {
  scheduleComputerSleep(deps.wakeup, computer.botId);
  const sandbox = deps.sandbox as SandboxProvider & {
    keepAlive?: (ref: ComputerRef, context?: AdapterContext) => Promise<void>;
  };
  const context: AdapterContext | undefined = computer.workspaceId
    ? {
        operationId: "computer.touch",
        traceId: "computer.touch",
        workspaceId: computer.workspaceId,
        userId: computer.userId ?? "",
        botId: computer.botId,
        signal: new AbortController().signal,
      }
    : undefined;
  await sandbox.keepAlive?.(
    {
      id: computer.providerRef,
      botId: computer.botId,
      kind: computer.kind as ComputerRef["kind"],
      providerRef: computer.providerRef,
      display: computer.display,
      screenUrl: computer.screenUrl,
    },
    context,
  );
}

async function suspendDesktopSession(
  deps: { prisma: PrismaClient; wakeup?: WakeupDriver },
  desktop: {
    botId: string;
    workspaceId: string;
  },
): Promise<void> {
  await closeComputerUsage(deps.prisma, desktop.botId);
  const bot = await deps.prisma.bot.findUnique({
    where: { id: desktop.botId },
    include: { thread: true },
  });
  if (bot?.thread) {
    await appendEvent(deps.prisma, {
      workspaceId: desktop.workspaceId,
      threadId: bot.thread.id,
      botId: desktop.botId,
      type: "computer.status",
      payload: { status: "suspended" },
    });
  }
}

/**
 * Parar o que o provedor já não tem (container parado depois de um reboot, sessão que
 * nunca abriu) é parar. Antes o 404 subia daqui, a linha ficava em "suspending" com o
 * claim, o recover devolvia a "running" e o sono tentava de novo — oscilando para sempre
 * num computador que já estava desligado.
 */
export async function sleepComputerIfIdle(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider; wakeup?: WakeupDriver },
  botId: string,
): Promise<void> {
  await recoverStaleDesktopSuspend(deps.prisma, botId);

  const desktop = await deps.prisma.desktopSession.findUnique({
    where: { botId },
    include: { computer: true },
  });
  if (!desktop) return;
  const providerRef = workspaceProviderRef(desktop) ?? null;
  if (!providerRef) return;
  if (desktop.state !== "running") return;
  if (desktop.controlHolder === "user" || controlLeaseLive(desktop, new Date())) {
    scheduleComputerSleep(deps.wakeup, botId);
    return;
  }

  const active = await deps.prisma.run.findFirst({
    where: { botId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    select: { id: true },
  });
  if (active) {
    scheduleComputerSleep(deps.wakeup, botId);
    return;
  }

  const claim = await claimDesktopSuspend(deps.prisma, botId);
  if (!claim) return;

  const stillActive = await deps.prisma.run.findFirst({
    where: { botId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    select: { id: true },
  });
  if (stillActive) {
    await releaseDesktopSuspendClaim(deps.prisma, botId, claim.token);
    scheduleComputerSleep(deps.wakeup, botId);
    return;
  }

  const kind = desktop.computer.kind;
  let shouldCallProvider = true;
  if (isWorkspaceScopedSandbox(kind)) {
    const activity = await sharedComputerSiblingActivity(deps.prisma, {
      computerId: desktop.computerId,
      workspaceId: desktop.workspaceId,
      botId,
    });
    shouldCallProvider = shouldStopSharedComputer({
      kind,
      ...activity,
      userHoldsControl: false,
    });
  }

  if (!shouldCallProvider) {
    if (await finalizeDesktopSuspended(deps.prisma, botId, claim.token)) {
      await suspendDesktopSession(deps, desktop);
    }
    return;
  }

  if (!(await validateDesktopSuspendClaim(deps.prisma, botId, claim.token))) {
    return;
  }

  const stopRef = computerRefFromSession(desktop);

  await reconcileProviderCleanupIntent(
    { prisma: deps.prisma, sandbox: deps.sandbox },
    {
      workspaceId: desktop.workspaceId,
      sessionBotId: botId,
      lifecycleAction: "stop:idle",
    },
  );

  await recordLifecycleCleanupIntent(deps.prisma, {
    ref: stopRef,
    action: "stop:idle",
    lifecycleToken: claim.token,
    sessionBotId: botId,
    workspaceId: desktop.workspaceId,
    reason: cleanupIntentReason("stop:idle"),
  });

  const ctx = {
    operationId: "computer.sleep",
    traceId: "computer.sleep",
    workspaceId: desktop.workspaceId,
    userId: desktop.computer.userId,
    botId,
    signal: new AbortController().signal,
  };

  const shared = isWorkspaceScopedSandbox(kind);
  if (!(await validateDesktopSuspendClaim(deps.prisma, botId, claim.token))) {
    return;
  }
  if (shared) {
    const gated = await withComputerSessionGate(deps.prisma, desktop.workspaceId, async () => {
      if (!(await validateDesktopSuspendClaim(deps.prisma, botId, claim.token))) {
        throw new Error("lost suspend claim");
      }
      await stopSandboxUnlessAlreadyGone(deps.sandbox, stopRef, ctx);
    });
    if (!gated.ok) {
      throw new Error("shared stop gate unavailable");
    }
  } else {
    await stopSandboxUnlessAlreadyGone(deps.sandbox, stopRef, ctx);
  }

  if (await finalizeDesktopSuspended(deps.prisma, botId, claim.token)) {
    await resolveLifecycleCleanupIntent(deps.prisma, {
      workspaceId: desktop.workspaceId,
      sessionBotId: botId,
      lifecycleAction: "stop:idle",
      lifecycleToken: claim.token,
    });
    await suspendDesktopSession(deps, desktop);
  } else {
    await releaseDesktopSuspendClaim(deps.prisma, botId, claim.token);
  }
}
