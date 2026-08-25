import type { ComputerRef, SandboxProvider } from "@quibt/adapter-kit";
import { controlLeaseLive } from "@quibt/core";
import type { PrismaClient } from "@quibt/db";
import type { ProviderCleanupAction } from "./session-lifecycle.js";
import { finalizeDesktopSuspended } from "./session-lifecycle.js";
import {
  isWorkspaceScopedSandbox,
  sharedComputerSiblingActivity,
  shouldStopSharedComputer,
  workspaceProviderRef,
} from "./workspace-computer.js";

export type LifecycleIntentContext = {
  lifecycleAction: ProviderCleanupAction;
  lifecycleToken: string;
  sessionBotId: string;
  refSnapshotKind: string;
  refSnapshotProviderRef: string;
};

export type LifecycleIntentRow = {
  workspaceId: string;
  botId: string | null;
  provider: string;
  providerRef: string;
  status: string;
  reason: string;
  lifecycleAction: string | null;
  lifecycleToken: string | null;
  sessionBotId: string | null;
  refSnapshotKind: string | null;
  refSnapshotProviderRef: string | null;
};

export type LifecycleIntentValidation =
  | { ok: true; action: ProviderCleanupAction }
  | { ok: false; reason: "reactivated" | "stale" | "lease" | "activity" | "missing" };

export function isBootOrphanRow(row: LifecycleIntentRow): boolean {
  return row.status === "pending" && !row.lifecycleAction;
}

export function isLifecycleCleanupRow(row: LifecycleIntentRow): boolean {
  return row.status === "pending" && Boolean(row.lifecycleAction);
}

export async function cancelPendingStopIntentsForSession(
  prisma: PrismaClient,
  input: { workspaceId: string; sessionBotId: string; provider: string; providerRef: string },
): Promise<void> {
  await prisma.orphanProvision.updateMany({
    where: {
      workspaceId: input.workspaceId,
      sessionBotId: input.sessionBotId,
      provider: input.provider,
      providerRef: input.providerRef,
      status: "pending",
      lifecycleAction: "stop:idle",
    },
    data: {
      status: "cancelled",
      reason: "session reactivated on control lease",
    },
  });
}

export async function clearSessionLifecycleToken(
  prisma: PrismaClient,
  botId: string,
): Promise<void> {
  await prisma.desktopSession.updateMany({
    where: { botId, state: { in: ["running", "suspending"] } },
    data: { bootClaimToken: null, bootClaimedAt: null },
  });
}

export function lifecycleContextFromRow(row: LifecycleIntentRow): LifecycleIntentContext | null {
  if (
    !row.lifecycleAction ||
    !row.lifecycleToken ||
    !row.sessionBotId ||
    !row.refSnapshotKind ||
    !row.refSnapshotProviderRef
  ) {
    return null;
  }
  if (row.lifecycleAction !== "stop:idle" && row.lifecycleAction !== "destroy:delete") {
    return null;
  }
  return {
    lifecycleAction: row.lifecycleAction,
    lifecycleToken: row.lifecycleToken,
    sessionBotId: row.sessionBotId,
    refSnapshotKind: row.refSnapshotKind,
    refSnapshotProviderRef: row.refSnapshotProviderRef,
  };
}

function isOrphanProvisionUniqueConflict(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

function lifecycleIntentIdentity(input: {
  workspaceId: string;
  sessionBotId: string;
  action: ProviderCleanupAction;
}) {
  return {
    workspaceId: input.workspaceId,
    sessionBotId: input.sessionBotId,
    lifecycleAction: input.action,
  };
}

function lifecycleIntentWriteData(input: {
  ref: ComputerRef;
  action: ProviderCleanupAction;
  lifecycleToken: string;
  sessionBotId: string;
  reason: string;
}) {
  return {
    reason: input.reason.slice(0, 500),
    status: "pending" as const,
    botId: input.sessionBotId,
    provider: input.ref.kind,
    providerRef: input.ref.providerRef,
    lifecycleToken: input.lifecycleToken,
    refSnapshotKind: input.ref.kind,
    refSnapshotProviderRef: input.ref.providerRef,
  };
}

async function writeLifecycleCleanupIntent(
  prisma: PrismaClient,
  input: {
    ref: ComputerRef;
    action: ProviderCleanupAction;
    lifecycleToken: string;
    sessionBotId: string;
    workspaceId: string;
    reason: string;
  },
): Promise<void> {
  const identity = lifecycleIntentIdentity({
    workspaceId: input.workspaceId,
    sessionBotId: input.sessionBotId,
    action: input.action,
  });
  const data = lifecycleIntentWriteData(input);

  const existing = await prisma.orphanProvision.findFirst({
    where: identity,
  });
  if (existing) {
    await prisma.orphanProvision.update({
      where: { id: existing.id },
      data,
    });
    return;
  }

  try {
    await prisma.orphanProvision.create({
      data: {
        ...identity,
        ...data,
      },
    });
  } catch (error) {
    if (!isOrphanProvisionUniqueConflict(error)) throw error;
    const raced = await prisma.orphanProvision.findFirst({ where: identity });
    if (!raced) throw error;
    await prisma.orphanProvision.update({
      where: { id: raced.id },
      data,
    });
  }
}

export async function recordLifecycleCleanupIntent(
  prisma: PrismaClient,
  input: {
    ref: ComputerRef;
    action: ProviderCleanupAction;
    lifecycleToken: string;
    sessionBotId: string;
    workspaceId: string;
    reason: string;
  },
): Promise<void> {
  // Each statement is its own implicit transaction. Do not wrap create+P2002
  // retry in prisma.$transaction: Postgres aborts the interactive transaction
  // after a unique violation, so the retry could not run.
  await writeLifecycleCleanupIntent(prisma, input);
}

export async function cancelLifecycleCleanupIntent(
  prisma: PrismaClient,
  input: {
    workspaceId: string;
    sessionBotId: string;
    lifecycleToken: string;
    lifecycleAction: ProviderCleanupAction;
    reason: string;
  },
): Promise<boolean> {
  const result = await prisma.orphanProvision.updateMany({
    where: {
      workspaceId: input.workspaceId,
      sessionBotId: input.sessionBotId,
      lifecycleAction: input.lifecycleAction,
      lifecycleToken: input.lifecycleToken,
      status: "pending",
    },
    data: {
      status: "cancelled",
      reason: input.reason.slice(0, 500),
    },
  });
  return result.count > 0;
}

export async function cancelBootOrphanIntent(
  prisma: PrismaClient,
  input: {
    workspaceId: string;
    provider: string;
    providerRef: string;
    reason: string;
  },
): Promise<boolean> {
  const result = await prisma.orphanProvision.updateMany({
    where: {
      workspaceId: input.workspaceId,
      provider: input.provider,
      providerRef: input.providerRef,
      status: "pending",
      lifecycleAction: null,
    },
    data: {
      status: "cancelled",
      reason: input.reason.slice(0, 500),
    },
  });
  return result.count > 0;
}

export async function resolveBootOrphanIntent(
  prisma: PrismaClient,
  input: {
    workspaceId: string;
    provider: string;
    providerRef: string;
  },
): Promise<boolean> {
  const result = await prisma.orphanProvision.updateMany({
    where: {
      workspaceId: input.workspaceId,
      provider: input.provider,
      providerRef: input.providerRef,
      lifecycleAction: null,
      status: "pending",
    },
    data: {
      status: "resolved",
      reason: "provider cleanup resolved",
    },
  });
  return result.count > 0;
}

export async function resolveLifecycleCleanupIntent(
  prisma: PrismaClient,
  input: {
    workspaceId: string;
    sessionBotId: string;
    lifecycleAction: ProviderCleanupAction;
    lifecycleToken: string;
  },
): Promise<boolean> {
  const result = await prisma.orphanProvision.updateMany({
    where: {
      workspaceId: input.workspaceId,
      sessionBotId: input.sessionBotId,
      lifecycleAction: input.lifecycleAction,
      lifecycleToken: input.lifecycleToken,
      status: "pending",
    },
    data: {
      status: "resolved",
      reason: "provider cleanup resolved",
    },
  });
  return result.count > 0;
}

export async function validateLifecycleCleanupIntent(
  prisma: PrismaClient,
  row: LifecycleIntentRow,
  now = new Date(),
): Promise<LifecycleIntentValidation> {
  const ctx = lifecycleContextFromRow(row);
  if (!ctx) return { ok: false, reason: "missing" };

  const session = await prisma.desktopSession.findUnique({
    where: { botId: ctx.sessionBotId },
    include: { computer: true },
  });
  if (!session) return { ok: false, reason: "missing" };

  const liveRef = workspaceProviderRef(session) ?? session.providerRef;
  if (liveRef !== ctx.refSnapshotProviderRef || session.computer.kind !== ctx.refSnapshotKind) {
    return { ok: false, reason: "stale" };
  }

  if (ctx.lifecycleAction === "stop:idle") {
    if (session.state === "running" || session.state === "booting") {
      return { ok: false, reason: "reactivated" };
    }
    if (session.state !== "suspending" || session.bootClaimToken !== ctx.lifecycleToken) {
      return { ok: false, reason: "stale" };
    }
    if (session.controlHolder === "user" || controlLeaseLive(session, now)) {
      return { ok: false, reason: "lease" };
    }
    if (isWorkspaceScopedSandbox(session.computer.kind)) {
      const activity = await sharedComputerSiblingActivity(prisma, {
        computerId: session.computerId,
        workspaceId: row.workspaceId,
        botId: ctx.sessionBotId,
      });
      if (
        !shouldStopSharedComputer({
          kind: session.computer.kind,
          ...activity,
          userHoldsControl: false,
        })
      ) {
        return { ok: false, reason: "activity" };
      }
    }
    return { ok: true, action: "stop:idle" };
  }

  if (session.state === "running" || session.state === "booting") {
    return { ok: false, reason: "reactivated" };
  }
  if (session.state !== "deleting" || session.bootClaimToken !== ctx.lifecycleToken) {
    return { ok: false, reason: "stale" };
  }
  return { ok: true, action: "destroy:delete" };
}

/** Boot-orphan intents destroy only when ref is not active on Computer or any Session. */
export async function isBootOrphanRefActive(
  prisma: PrismaClient,
  input: {
    workspaceId: string;
    kind: string;
    providerRef: string;
  },
): Promise<boolean> {
  const computer = await prisma.computer.findUnique({
    where: { workspaceId: input.workspaceId },
    select: { providerRef: true, state: true, kind: true },
  });
  if (
    computer?.providerRef === input.providerRef &&
    (computer.state === "running" || computer.state === "warming" || computer.state === "booting")
  ) {
    return true;
  }

  const session = await prisma.desktopSession.findFirst({
    where: {
      workspaceId: input.workspaceId,
      providerRef: input.providerRef,
      state: { in: ["running", "booting", "suspending", "deleting"] },
    },
    select: { botId: true },
  });
  return Boolean(session);
}

export async function finalizeLifecycleStopAfterProvider(
  prisma: PrismaClient,
  input: { sessionBotId: string; lifecycleToken: string },
): Promise<boolean> {
  return finalizeDesktopSuspended(prisma, input.sessionBotId, input.lifecycleToken);
}

export function refFromLifecycleRow(row: LifecycleIntentRow): ComputerRef {
  return {
    id: row.refSnapshotProviderRef ?? row.providerRef,
    botId: row.sessionBotId ?? row.botId ?? "workspace",
    kind: (row.refSnapshotKind ?? row.provider) as ComputerRef["kind"],
    providerRef: row.refSnapshotProviderRef ?? row.providerRef,
  };
}

export type ReconcileLifecycleDeps = {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home?: import("@quibt/adapter-kit").AgentHomeStore;
  dataDir?: string;
};
