import { randomUUID } from "node:crypto";
import type { ComputerRef } from "@quibt/adapter-kit";
import type { PrismaClient } from "@quibt/db";
import { DESKTOP_BOOT_STALE_MS } from "./computer-boot-timing.js";

export const DESKTOP_SUSPEND_STALE_MS = DESKTOP_BOOT_STALE_MS;
export const DESKTOP_DELETE_STALE_MS = DESKTOP_BOOT_STALE_MS;
export const COMPUTER_SESSION_GATE_STALE_MS = DESKTOP_BOOT_STALE_MS;

export const DESKTOP_BOOT_BLOCKED_STATES = ["suspending", "deleting", "booting"] as const;

export const LIFECYCLE_RESTORE_PREFIX = "lifecycle-restore:";

export type LifecycleClaim = {
  token: string;
  claimedAt: Date;
};

export type ProviderCleanupAction = "stop:idle" | "destroy:delete";

export function cleanupIntentReason(action: ProviderCleanupAction): string {
  return `provider cleanup ${action}`;
}

export type CleanupIntentRef = Pick<ComputerRef, "kind" | "providerRef" | "botId">;

function staleBefore(now: Date, ms: number): Date {
  return new Date(now.getTime() - ms);
}

export function encodeLifecycleRestoreState(state: string): string {
  return `${LIFECYCLE_RESTORE_PREFIX}${state}`;
}

export function decodeLifecycleRestoreState(
  bootLastError: string | null | undefined,
): string | null {
  if (!bootLastError?.startsWith(LIFECYCLE_RESTORE_PREFIX)) return null;
  return bootLastError.slice(LIFECYCLE_RESTORE_PREFIX.length) || null;
}

export function isDesktopBootBlocked(state: string): boolean {
  return (DESKTOP_BOOT_BLOCKED_STATES as readonly string[]).includes(state);
}

/** Stale suspend claims return to running so stop can be re-executed; pending intent is reused. */
export async function recoverStaleDesktopSuspend(
  prisma: PrismaClient,
  botId: string,
  now = new Date(),
): Promise<boolean> {
  const stale = staleBefore(now, DESKTOP_SUSPEND_STALE_MS);
  const recovered = await prisma.desktopSession.updateMany({
    where: {
      botId,
      state: "suspending",
      OR: [{ bootClaimedAt: { lt: stale } }, { bootClaimedAt: null, updatedAt: { lt: stale } }],
    },
    data: {
      state: "running",
      bootClaimToken: null,
      bootClaimedAt: null,
    },
  });
  return recovered.count === 1;
}

/**
 * Um sono interrompido no meio (worker reiniciado numa atualização do app, por exemplo)
 * deixava a sessão em "suspending" para sempre do ponto de vista do boot: ele não pega
 * essa linha e ninguém mais a devolvia. Para quem vai ligar a tela, o estado seguro é
 * "suspended": se o Xvfb ainda está de pé, o start responde "already-running"; se já
 * morreu, ele sobe de novo. Devolver a "running" daria um computador fantasma.
 */
export async function recoverStaleDesktopSuspendForBoot(
  prisma: PrismaClient,
  botId: string,
  now = new Date(),
): Promise<boolean> {
  const stale = staleBefore(now, DESKTOP_SUSPEND_STALE_MS);
  const recovered = await prisma.desktopSession.updateMany({
    where: {
      botId,
      state: "suspending",
      OR: [{ bootClaimedAt: { lt: stale } }, { bootClaimedAt: null, updatedAt: { lt: stale } }],
    },
    data: {
      state: "suspended",
      bootClaimToken: null,
      bootClaimedAt: null,
      controlHolder: "none",
    },
  });
  return recovered.count === 1;
}

/** Stale delete claims return to a retryable state, keeping providerRef and pending intent. */
export async function recoverStaleDesktopDelete(
  prisma: PrismaClient,
  botId: string,
  now = new Date(),
): Promise<boolean> {
  const stale = staleBefore(now, DESKTOP_DELETE_STALE_MS);
  const session = await prisma.desktopSession.findUnique({
    where: { botId },
    select: { bootLastError: true },
  });
  const restoreState = decodeLifecycleRestoreState(session?.bootLastError ?? null) ?? "error";
  const recovered = await prisma.desktopSession.updateMany({
    where: {
      botId,
      state: "deleting",
      OR: [{ bootClaimedAt: { lt: stale } }, { bootClaimedAt: null, updatedAt: { lt: stale } }],
    },
    data: {
      state: restoreState,
      bootClaimToken: null,
      bootClaimedAt: null,
      bootLastError:
        restoreState === "error"
          ? "stale delete claim recovered; retry destroy"
          : encodeLifecycleRestoreState(restoreState),
    },
  });
  return recovered.count === 1;
}

/** Clears a stale shared-computer session gate token so boot/delete can proceed. */
export async function recoverStaleComputerSessionGate(
  prisma: PrismaClient,
  workspaceId: string,
  now = new Date(),
): Promise<boolean> {
  const stale = staleBefore(now, COMPUTER_SESSION_GATE_STALE_MS);
  const recovered = await prisma.computer.updateMany({
    where: {
      workspaceId,
      state: { notIn: ["warming", "booting"] },
      bootClaimToken: { not: null },
      OR: [{ bootClaimedAt: { lt: stale } }, { bootClaimedAt: null, updatedAt: { lt: stale } }],
    },
    data: {
      bootClaimToken: null,
      bootClaimedAt: null,
    },
  });
  return recovered.count > 0;
}

export async function claimDesktopSuspend(
  prisma: PrismaClient,
  botId: string,
  now = new Date(),
): Promise<LifecycleClaim | null> {
  await recoverStaleDesktopSuspend(prisma, botId, now);
  const token = randomUUID();
  const claimed = await prisma.desktopSession.updateMany({
    where: {
      botId,
      state: "running",
      bootClaimToken: null,
      controlHolder: { not: "user" },
    },
    data: {
      state: "suspending",
      bootClaimToken: token,
      bootClaimedAt: now,
    },
  });
  if (claimed.count !== 1) return null;
  return { token, claimedAt: now };
}

export async function validateDesktopSuspendClaim(
  prisma: PrismaClient,
  botId: string,
  token: string,
): Promise<boolean> {
  const session = await prisma.desktopSession.findUnique({
    where: { botId },
    select: { state: true, bootClaimToken: true, controlHolder: true },
  });
  if (!session) return false;
  if (session.state !== "suspending" || session.bootClaimToken !== token) return false;
  if (session.controlHolder === "user") return false;
  return true;
}

export async function finalizeDesktopSuspended(
  prisma: PrismaClient,
  botId: string,
  token: string,
): Promise<boolean> {
  const finalized = await prisma.desktopSession.updateMany({
    where: { botId, state: "suspending", bootClaimToken: token },
    data: {
      state: "suspended",
      bootClaimToken: null,
      bootClaimedAt: null,
      controlHolder: "none",
    },
  });
  return finalized.count === 1;
}

export async function releaseDesktopSuspendClaim(
  prisma: PrismaClient,
  botId: string,
  token: string,
): Promise<boolean> {
  const released = await prisma.desktopSession.updateMany({
    where: { botId, state: "suspending", bootClaimToken: token },
    data: {
      state: "running",
      bootClaimToken: null,
      bootClaimedAt: null,
    },
  });
  return released.count === 1;
}

export async function claimDesktopDelete(
  prisma: PrismaClient,
  botId: string,
  now = new Date(),
): Promise<LifecycleClaim | null> {
  await recoverStaleDesktopDelete(prisma, botId, now);
  const current = await prisma.desktopSession.findUnique({
    where: { botId },
    select: { state: true },
  });
  const retryableStates = new Set(["running", "suspended", "stopped", "error"]);
  if (!current || !retryableStates.has(current.state)) {
    return null;
  }
  const token = randomUUID();
  const claimed = await prisma.desktopSession.updateMany({
    where: {
      botId,
      state: { in: ["running", "suspended", "stopped", "error"] },
      bootClaimToken: null,
    },
    data: {
      state: "deleting",
      bootClaimToken: token,
      bootClaimedAt: now,
      bootLastError: encodeLifecycleRestoreState(current.state),
    },
  });
  if (claimed.count !== 1) return null;
  return { token, claimedAt: now };
}

export async function validateDesktopDeleteClaim(
  prisma: PrismaClient,
  botId: string,
  token: string,
): Promise<"valid" | "reactivated" | "lost"> {
  const session = await prisma.desktopSession.findUnique({
    where: { botId },
    select: { state: true, bootClaimToken: true },
  });
  if (!session) return "lost";
  if (session.state === "deleting" && session.bootClaimToken === token) return "valid";
  if (session.state === "booting" || session.state === "running") return "reactivated";
  return "lost";
}

/**
 * Renova a marca de exclusão enquanto ela está em uso.
 *
 * Apagar o histórico pesado em lotes pode passar de DESKTOP_DELETE_STALE_MS. Sem renovar,
 * `recoverStaleDesktopDelete` devolveria a sessão a "running" no meio do trabalho e o
 * dono da marca perderia a corrida contra si mesmo.
 */
export async function renewDesktopDeleteClaim(
  prisma: PrismaClient,
  botId: string,
  token: string,
  now = new Date(),
): Promise<boolean> {
  const renewed = await prisma.desktopSession.updateMany({
    where: { botId, state: "deleting", bootClaimToken: token },
    data: { bootClaimedAt: now },
  });
  return renewed.count === 1;
}

/**
 * Encerra a exclusão devolvendo a sessão a "stopped" e SOLTANDO a marca.
 *
 * Cuidado: quem solta a marca perde a retomada. A exclusão de bot não usa isto — ela
 * segura o estado "deleting" e o token até a remoção final da linha
 * (`bot-destroy-finalize.ts`), para que uma falha no meio possa ser retomada.
 */
export async function finalizeDesktopDelete(
  prisma: PrismaClient,
  botId: string,
  token: string,
): Promise<boolean> {
  const finalized = await prisma.desktopSession.updateMany({
    where: { botId, state: "deleting", bootClaimToken: token },
    data: {
      state: "stopped",
      bootClaimToken: null,
      bootClaimedAt: null,
      bootLastError: null,
      providerRef: null,
      screenUrl: null,
      controlHolder: "none",
      controlLeaseId: null,
      controlLeaseUserId: null,
      controlLeaseExpiresAt: null,
    },
  });
  return finalized.count === 1;
}

export async function releaseDesktopDeleteClaim(
  prisma: PrismaClient,
  botId: string,
  token: string,
  restoreState: "running" | "suspended" | "stopped" | "error",
): Promise<boolean> {
  const released = await prisma.desktopSession.updateMany({
    where: { botId, state: "deleting", bootClaimToken: token },
    data: {
      state: restoreState,
      bootClaimToken: null,
      bootClaimedAt: null,
      bootLastError: encodeLifecycleRestoreState(restoreState),
    },
  });
  return released.count === 1;
}

/**
 * Shared-computer session-start gate: serializes workspace boot connect/persist and shared
 * destroy against the same fencing token on `Computer`.
 */
export async function claimComputerSessionStartGate(
  prisma: PrismaClient,
  workspaceId: string,
  now = new Date(),
): Promise<LifecycleClaim | null> {
  await recoverStaleComputerSessionGate(prisma, workspaceId, now);
  const token = randomUUID();
  const claimed = await prisma.computer.updateMany({
    where: { workspaceId, bootClaimToken: null },
    data: {
      bootClaimToken: token,
      bootClaimedAt: now,
    },
  });
  if (claimed.count !== 1) return null;
  return { token, claimedAt: now };
}

/** @deprecated Use {@link claimComputerSessionStartGate}. */
export const claimComputerSharedCleanup = claimComputerSessionStartGate;

export async function validateComputerSessionStartGate(
  prisma: PrismaClient,
  workspaceId: string,
  token: string,
): Promise<boolean> {
  const computer = await prisma.computer.findUnique({
    where: { workspaceId },
    select: { bootClaimToken: true },
  });
  return computer?.bootClaimToken === token;
}

/** @deprecated Use {@link validateComputerSessionStartGate}. */
export const validateComputerSharedCleanupClaim = validateComputerSessionStartGate;

export async function releaseComputerSessionStartGate(
  prisma: PrismaClient,
  workspaceId: string,
  token: string,
): Promise<boolean> {
  const released = await prisma.computer.updateMany({
    where: { workspaceId, bootClaimToken: token },
    data: {
      bootClaimToken: null,
      bootClaimedAt: null,
    },
  });
  return released.count === 1;
}

/** @deprecated Use {@link releaseComputerSessionStartGate}. */
export const releaseComputerSharedCleanupClaim = releaseComputerSessionStartGate;

/** Waits for session gate release; recovers stale gate before wait and retries once after bounded wait. */
export async function waitForComputerSessionGateOrRecover(
  prisma: PrismaClient,
  workspaceId: string,
  options?: { timeoutMs?: number; pollMs?: number },
): Promise<boolean> {
  await recoverStaleComputerSessionGate(prisma, workspaceId);
  const initial = await prisma.computer.findUnique({
    where: { workspaceId },
    select: { bootClaimToken: true },
  });
  if (!initial?.bootClaimToken) return true;

  const timeoutMs = options?.timeoutMs ?? SESSION_GATE_BOUNDED_WAIT_MS;
  const released = await waitForComputerSessionGateRelease(prisma, workspaceId, {
    timeoutMs,
    pollMs: options?.pollMs,
  });
  if (released) return true;

  await recoverStaleComputerSessionGate(prisma, workspaceId);
  const afterRecover = await prisma.computer.findUnique({
    where: { workspaceId },
    select: { bootClaimToken: true },
  });
  return !afterRecover?.bootClaimToken;
}

/**
 * Quanto um boot espera o portão de sessão do computador compartilhado. Quem o segura
 * está subindo a tela de outro bot (Xvfb + Chromium + noVNC), o que leva bem mais que
 * 5 s; com 5 s o segundo bot a falar no mesmo computador falhava o run inteiro com
 * "Timed out waiting for workspace computer session gate" em vez de só esperar a vez.
 */
export const SESSION_GATE_BOUNDED_WAIT_MS = 45_000;
export const SESSION_GATE_HEARTBEAT_MS = 30_000;

export async function renewComputerSessionStartGate(
  prisma: PrismaClient,
  workspaceId: string,
  token: string,
  now = new Date(),
): Promise<boolean> {
  const renewed = await prisma.computer.updateMany({
    where: { workspaceId, bootClaimToken: token },
    data: { bootClaimedAt: now },
  });
  return renewed.count === 1;
}

/** Runs `fn` while holding the session gate and renewing it until `fn` settles. */
export async function withComputerSessionGate<T>(
  prisma: PrismaClient,
  workspaceId: string,
  fn: () => Promise<T>,
  options?: { intervalMs?: number },
): Promise<{ ok: true; value: T } | { ok: false }> {
  const gate = await claimComputerSessionStartGate(prisma, workspaceId);
  if (!gate) return { ok: false };
  const intervalMs = options?.intervalMs ?? SESSION_GATE_HEARTBEAT_MS;
  const heartbeat = setInterval(() => {
    void renewComputerSessionStartGate(prisma, workspaceId, gate.token).catch(() => undefined);
  }, intervalMs);
  try {
    const value = await fn();
    return { ok: true, value };
  } finally {
    clearInterval(heartbeat);
    await releaseComputerSessionStartGate(prisma, workspaceId, gate.token);
  }
}

/** Renews a held gate until `stop()` is called (for long external operations). */
export function startComputerSessionGateHeartbeat(
  prisma: PrismaClient,
  workspaceId: string,
  token: string,
  options?: { intervalMs?: number },
): () => void {
  const intervalMs = options?.intervalMs ?? SESSION_GATE_HEARTBEAT_MS;
  const interval = setInterval(() => {
    void renewComputerSessionStartGate(prisma, workspaceId, token).catch(() => undefined);
  }, intervalMs);
  return () => clearInterval(interval);
}

export async function waitForComputerSessionGateRelease(
  prisma: PrismaClient,
  workspaceId: string,
  options?: { timeoutMs?: number; pollMs?: number },
): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? DESKTOP_BOOT_STALE_MS;
  const pollMs = options?.pollMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const computer = await prisma.computer.findUnique({
      where: { workspaceId },
      select: { bootClaimToken: true },
    });
    if (!computer?.bootClaimToken) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}
