import { rm } from "node:fs/promises";
import type { AgentHomeStore } from "@quibt/adapter-kit";
import { closeComputerUsage, type PrismaClient } from "@quibt/db";
import { resolveAgentHomePath } from "./home.js";
import {
  finalizeDesktopDelete,
  releaseComputerSessionStartGate,
  releaseDesktopDeleteClaim,
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

/** Shared bot/session removal after provider destroy succeeds (normal path + reconciler). */
export async function finalizeBotDestroyAfterProvider(
  deps: {
    prisma: PrismaClient;
    home: AgentHomeStore;
    dataDir?: string;
  },
  input: BotDestroyFinalizeInput,
): Promise<boolean> {
  const finalized = await finalizeDesktopDelete(deps.prisma, input.botId, input.claimToken);
  if (!finalized) {
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

  const computer = input.computer;
  await deps.prisma.$transaction(async (tx) => {
    await tx.desktopSession.deleteMany({ where: { botId: input.botId } });
    await tx.bot.delete({ where: { id: input.botId } });
    if (computer) {
      const sessions = await tx.desktopSession.count({
        where: { computerId: computer.id },
      });
      if (sessions === 0) {
        await tx.computer.delete({ where: { id: computer.id } }).catch(() => undefined);
      }
    }
  });

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
