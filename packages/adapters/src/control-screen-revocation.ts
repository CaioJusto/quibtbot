import type { SandboxProvider, WakeupDriver } from "@quibt/adapter-kit";
import type { PrismaClient } from "@quibt/db";
import { screenUsesTransientVncCredential } from "./computer-boot.js";
import { desktopSessionProviderRef } from "./workspace-computer.js";

export const CONTROL_SCREEN_REVOKE_JOB = "control.screen.revoke";
export const CONTROL_SCREEN_REVOKE_MAX_ATTEMPTS = 6;
export const CONTROL_SCREEN_REVOKE_TIMEOUT_MS = 15_000;

/** Rotate the per-display Docker credential and forget any cached screen address. */
export async function revokeControlScreen(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider },
  botId: string,
): Promise<"revoked" | "skipped"> {
  const session = await deps.prisma.desktopSession.findUnique({
    where: { botId },
    include: { computer: true },
  });
  if (!session || !screenUsesTransientVncCredential(session.computer.kind)) return "skipped";
  const providerRef = desktopSessionProviderRef(session) ?? session.providerRef;
  if (!providerRef || !deps.sandbox.revokeScreen) return "skipped";
  await deps.sandbox.revokeScreen(
    {
      id: providerRef,
      botId,
      kind: session.computer.kind as never,
      providerRef,
      display: session.display,
    },
    {
      operationId: "control.screen.revoke",
      traceId: "control.screen.revoke",
      workspaceId: session.workspaceId,
      userId: "system",
      botId,
      signal: AbortSignal.timeout(CONTROL_SCREEN_REVOKE_TIMEOUT_MS),
    },
  );
  await deps.prisma.desktopSession.updateMany({
    where: { botId },
    data: { screenUrl: null },
  });
  return "revoked";
}

export function scheduleControlScreenRevocation(
  wakeup: WakeupDriver | undefined,
  botId: string,
  attempt = 1,
): void {
  if (!wakeup || attempt > CONTROL_SCREEN_REVOKE_MAX_ATTEMPTS) return;
  const delayMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  void wakeup
    .enqueue({
      name: CONTROL_SCREEN_REVOKE_JOB,
      payload: { botId, attempt },
      runAt: new Date(Date.now() + delayMs),
      jobKey: `${CONTROL_SCREEN_REVOKE_JOB}:${botId}`,
    })
    .catch((error) => console.error(CONTROL_SCREEN_REVOKE_JOB, error));
}

/** Release must complete even if Docker vanished; retry revocation independently. */
export async function revokeControlScreenOrSchedule(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider; wakeup?: WakeupDriver },
  botId: string,
  attempt = 0,
): Promise<boolean> {
  try {
    await revokeControlScreen(deps, botId);
    return true;
  } catch (error) {
    if (attempt >= CONTROL_SCREEN_REVOKE_MAX_ATTEMPTS) {
      console.error(`${CONTROL_SCREEN_REVOKE_JOB} exhausted for ${botId}`, error);
      return false;
    }
    scheduleControlScreenRevocation(deps.wakeup, botId, attempt + 1);
    return false;
  }
}
