import type { PrismaClient } from "@quibt/db";
import {
  cancelPendingStopIntentsForSession,
  clearSessionLifecycleToken,
} from "./lifecycle-cleanup-intent.js";
import { desktopSessionProviderRef } from "./workspace-computer.js";

/** After a control lease is granted: clear suspend token and cancel pending stop intents. */
export async function onControlLeaseGranted(
  prisma: PrismaClient,
  input: { botId: string },
): Promise<void> {
  const session = await prisma.desktopSession.findUnique({
    where: { botId: input.botId },
    include: { computer: true },
  });
  if (!session) return;
  await clearSessionLifecycleToken(prisma, input.botId);
  const providerRef = desktopSessionProviderRef(session) ?? session.providerRef;
  if (!providerRef) return;
  await cancelPendingStopIntentsForSession(prisma, {
    workspaceId: session.workspaceId,
    sessionBotId: input.botId,
    provider: session.computer.kind,
    providerRef,
  });
}
