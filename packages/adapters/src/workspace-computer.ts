import { controlLeaseLive } from "@quibt/core";
import type { PrismaClient } from "@quibt/db";

/**
 * Docker and remote-supervisor share one machine per workspace. E2B, Box, and Daytona
 * use one sandbox/VM per bot. Callers must persist `providerRef` on `Computer`
 * for workspace-scoped kinds and only stop/destroy the VM when no sibling
 * session still needs it.
 */
export const ACTIVE_RUN_STATUSES = [
  "queued",
  "leased",
  "running",
  "waiting_input",
  "waiting_takeover",
] as const;

export function isWorkspaceScopedSandbox(kind: string | null | undefined): boolean {
  return kind === "docker" || kind === "remote-supervisor";
}

export function isPerBotSandbox(kind: string | null | undefined): boolean {
  return !isWorkspaceScopedSandbox(kind);
}

export function providerRefsFor(
  kind: string | null | undefined,
  providerRef: string,
): { computerProviderRef: string | null; desktopProviderRef: string } {
  if (isWorkspaceScopedSandbox(kind)) {
    return {
      computerProviderRef: providerRef,
      desktopProviderRef: providerRef,
    };
  }
  return {
    computerProviderRef: null,
    desktopProviderRef: providerRef,
  };
}

export function workspaceProviderRef(desktop: {
  providerRef: string | null;
  computer: { kind: string; providerRef: string | null };
}): string | undefined {
  if (isWorkspaceScopedSandbox(desktop.computer.kind)) {
    return desktop.computer.providerRef ?? desktop.providerRef ?? undefined;
  }
  return desktop.providerRef ?? undefined;
}

export function shouldStopSharedComputer(args: {
  kind: string;
  otherRunningSessions: number;
  otherActiveRuns: number;
  otherActiveLeases?: number;
  userHoldsControl?: boolean;
}): boolean {
  if (args.userHoldsControl) return false;
  if (!isWorkspaceScopedSandbox(args.kind)) return true;
  return (
    args.otherRunningSessions === 0 &&
    args.otherActiveRuns === 0 &&
    (args.otherActiveLeases ?? 0) === 0
  );
}

export type SharedComputerSiblingActivity = {
  otherRunningSessions: number;
  otherActiveRuns: number;
  otherActiveLeases: number;
};

export async function sharedComputerSiblingActivity(
  prisma: PrismaClient,
  input: { computerId: string; workspaceId: string; botId: string },
  now = new Date(),
): Promise<SharedComputerSiblingActivity> {
  const siblings = await prisma.desktopSession.findMany({
    where: {
      computerId: input.computerId,
      botId: { not: input.botId },
      state: { in: ["running", "booting", "suspending"] },
    },
    select: {
      botId: true,
      state: true,
      controlHolder: true,
      controlLeaseId: true,
      controlLeaseUserId: true,
      controlLeaseExpiresAt: true,
      controlFence: true,
    },
  });
  const otherRunningSessions = siblings.filter(
    (s) => s.state === "running" || s.state === "booting",
  ).length;
  const otherActiveLeases = siblings.filter(
    (s) => controlLeaseLive(s, now) && s.controlLeaseId !== null,
  ).length;
  const otherActiveRuns = await prisma.run.count({
    where: {
      workspaceId: input.workspaceId,
      botId: { not: input.botId },
      status: { in: [...ACTIVE_RUN_STATUSES] },
      bot: { desktopSession: { computerId: input.computerId } },
    },
  });
  return { otherRunningSessions, otherActiveRuns, otherActiveLeases };
}

/** Per-bot providers read only the desktop session ref; never legacy Computer refs. */
export function desktopSessionProviderRef(desktop: {
  providerRef: string | null;
  computer: { kind: string; providerRef: string | null };
}): string | undefined {
  if (isPerBotSandbox(desktop.computer.kind)) {
    return desktop.providerRef ?? undefined;
  }
  return desktop.computer.providerRef ?? desktop.providerRef ?? undefined;
}
