import { randomUUID } from "node:crypto";
import type { ComputerRef } from "@quibt/adapter-kit";
import type { PrismaClient } from "@quibt/db";
import {
  BOOT_CLAIM_HEARTBEAT_MS,
  DESKTOP_BOOT_POLL_MS,
  DESKTOP_BOOT_STALE_MS,
  DESKTOP_BOOT_WAIT_MS,
} from "./computer-boot-timing.js";
import {
  computerRunningDataFromProvision,
  desktopRunningDataFromProvision,
} from "./provider-ref-persistence.js";
import {
  recoverStaleComputerSessionGate,
  recoverStaleDesktopSuspendForBoot,
} from "./session-lifecycle.js";
import { workspaceProviderRef } from "./workspace-computer.js";

export {
  BOOT_CLAIM_HEARTBEAT_MS,
  DESKTOP_BOOT_POLL_MS,
  DESKTOP_BOOT_STALE_MS,
  DESKTOP_BOOT_WAIT_MS,
} from "./computer-boot-timing.js";

const BOOTABLE_DESKTOP_STATES = ["stopped", "error", "suspended"] as const;
const BOOTABLE_COMPUTER_STATES = ["stopped", "error", "suspended"] as const;

export type BootClaim = {
  token: string;
  claimedAt: Date;
};

export type DesktopSessionWithComputer = {
  botId: string;
  computerId: string;
  display: number;
  providerRef: string | null;
  screenUrl: string | null;
  state: string;
  bootClaimToken: string | null;
  bootClaimedAt: Date | null;
  bootLastError: string | null;
  computer: {
    id: string;
    kind: string;
    providerRef: string | null;
    state?: string;
    bootClaimToken?: string | null;
    bootClaimedAt?: Date | null;
    bootLastError?: string | null;
  };
};

export type ComputerRow = {
  id: string;
  workspaceId: string;
  kind: string;
  providerRef: string | null;
  state: string;
  bootClaimToken: string | null;
  bootClaimedAt: Date | null;
  bootLastError: string | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function staleBefore(now: Date): Date {
  return new Date(now.getTime() - DESKTOP_BOOT_STALE_MS);
}

function bootErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

export function computerRefFromSession(session: DesktopSessionWithComputer): ComputerRef {
  const providerRef = workspaceProviderRef(session) ?? session.providerRef ?? session.botId;
  return {
    id: providerRef,
    botId: session.botId,
    kind: session.computer.kind as ComputerRef["kind"],
    providerRef,
    display: session.display,
    screenUrl: session.screenUrl ?? undefined,
  };
}

export function computerRefFromComputer(computer: ComputerRow): ComputerRef {
  const providerRef = computer.providerRef ?? computer.id;
  return {
    id: providerRef,
    botId: "workspace",
    kind: computer.kind as ComputerRef["kind"],
    providerRef,
  };
}

export class BootClaimLostError<T = unknown> extends Error {
  readonly result: T | undefined;

  constructor(result?: T) {
    super("Boot claim lost during provision");
    this.name = "BootClaimLostError";
    this.result = result;
  }
}

/**
 * Runs `fn` while periodically renewing a boot claim heartbeat until `fn` completes or
 * `stopWhen` aborts. When renew fails or the claim is lost, aborts `abortOnLostClaim` and
 * signals {@link BootClaimLostError} to the caller after `fn` settles.
 */
export async function withBootClaimHeartbeat<T>(
  renew: () => Promise<boolean>,
  fn: () => Promise<T>,
  options?: {
    intervalMs?: number;
    stopWhen?: AbortSignal;
    abortOnLostClaim?: AbortController;
  },
): Promise<T> {
  const intervalMs = options?.intervalMs ?? BOOT_CLAIM_HEARTBEAT_MS;
  let lost = false;
  let interval: ReturnType<typeof setInterval> | undefined;

  const stop = () => {
    if (interval !== undefined) {
      clearInterval(interval);
      interval = undefined;
    }
  };

  const markLost = () => {
    if (lost) return;
    lost = true;
    options?.abortOnLostClaim?.abort();
    stop();
  };

  interval = setInterval(() => {
    void renew()
      .then((ok) => {
        if (!ok) markLost();
      })
      .catch(() => {
        markLost();
      });
  }, intervalMs);

  if (options?.stopWhen) {
    if (options.stopWhen.aborted) stop();
    else options.stopWhen.addEventListener("abort", stop, { once: true });
  }
  try {
    const result = await fn();
    if (lost) throw new BootClaimLostError(result);
    return result;
  } catch (error) {
    if (lost) {
      if (error instanceof BootClaimLostError) throw error;
      throw new BootClaimLostError();
    }
    throw error;
  } finally {
    stop();
    if (options?.stopWhen) options.stopWhen.removeEventListener("abort", stop);
  }
}

/**
 * Atomically claims a desktop session for boot. Returns a fencing token or null when another
 * live claim exists.
 */
export async function claimDesktopBoot(
  prisma: PrismaClient,
  botId: string,
  now = new Date(),
): Promise<BootClaim | null> {
  await recoverStaleDesktopSuspendForBoot(prisma, botId, now);
  const token = randomUUID();
  const stale = staleBefore(now);
  const claimed = await prisma.desktopSession.updateMany({
    where: {
      botId,
      state: { notIn: ["suspending", "deleting"] },
      OR: [
        { state: { in: [...BOOTABLE_DESKTOP_STATES] }, bootClaimToken: null },
        {
          state: "booting",
          OR: [{ bootClaimedAt: { lt: stale } }, { bootClaimedAt: null, updatedAt: { lt: stale } }],
        },
      ],
    },
    data: {
      state: "booting",
      bootClaimToken: token,
      bootClaimedAt: now,
    },
  });
  if (claimed.count !== 1) return null;
  return { token, claimedAt: now };
}

export async function renewDesktopBootClaim(
  prisma: PrismaClient,
  botId: string,
  token: string,
  now = new Date(),
): Promise<boolean> {
  const renewed = await prisma.desktopSession.updateMany({
    where: { botId, state: "booting", bootClaimToken: token },
    data: { bootClaimedAt: now },
  });
  return renewed.count === 1;
}

export async function persistDesktopSessionBoot(
  prisma: PrismaClient,
  input: {
    botId: string;
    token: string;
    ref: Pick<ComputerRef, "kind" | "providerRef" | "screenUrl" | "display">;
    existing: { display?: number | null };
    assignControlToBot?: boolean;
  },
): Promise<boolean> {
  const desktopData = desktopRunningDataFromProvision(
    input.ref,
    input.existing,
    input.assignControlToBot ? { controlHolder: "bot" } : undefined,
  );
  const sessionResult = await prisma.desktopSession.updateMany({
    where: { botId: input.botId, state: "booting", bootClaimToken: input.token },
    data: {
      ...desktopData,
      bootClaimToken: null,
      bootClaimedAt: null,
    },
  });
  return sessionResult.count === 1;
}

export async function persistDesktopBoot(
  prisma: PrismaClient,
  input: {
    botId: string;
    computerId: string;
    token: string;
    ref: Pick<ComputerRef, "kind" | "providerRef" | "screenUrl" | "display">;
    existing: { display?: number | null };
    assignControlToBot?: boolean;
  },
): Promise<boolean> {
  const desktopData = desktopRunningDataFromProvision(
    input.ref,
    input.existing,
    input.assignControlToBot ? { controlHolder: "bot" } : undefined,
  );
  return await prisma.$transaction(async (tx) => {
    const sessionResult = await tx.desktopSession.updateMany({
      where: { botId: input.botId, state: "booting", bootClaimToken: input.token },
      data: {
        ...desktopData,
        bootClaimToken: null,
        bootClaimedAt: null,
      },
    });
    if (sessionResult.count !== 1) return false;
    await tx.computer.update({
      where: { id: input.computerId },
      data: computerRunningDataFromProvision(input.ref),
    });
    return true;
  });
}

export async function releaseDesktopBootFailure(
  prisma: PrismaClient,
  botId: string,
  token: string,
  error?: unknown,
): Promise<boolean> {
  const message = error !== undefined ? bootErrorMessage(error) : undefined;
  const released = await prisma.desktopSession.updateMany({
    where: { botId, state: "booting", bootClaimToken: token },
    data: {
      state: "error",
      bootClaimToken: null,
      bootClaimedAt: null,
      ...(message ? { bootLastError: message } : {}),
    },
  });
  return released.count === 1;
}

/** Records cleanup telemetry without touching rows claimed by another worker. */
export async function recordDesktopBootCleanupFailure(
  prisma: PrismaClient,
  botId: string,
  token: string,
  error: unknown,
): Promise<void> {
  await prisma.desktopSession.updateMany({
    where: { botId, bootClaimToken: token },
    data: { bootLastError: bootErrorMessage(error) },
  });
}

export async function waitForDesktopBoot(
  prisma: PrismaClient,
  botId: string,
  options?: { timeoutMs?: number; pollMs?: number },
): Promise<DesktopSessionWithComputer | null> {
  const timeoutMs = options?.timeoutMs ?? DESKTOP_BOOT_WAIT_MS;
  const pollMs = options?.pollMs ?? DESKTOP_BOOT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await prisma.desktopSession.findUnique({
      where: { botId },
      include: { computer: true },
    });
    if (!session) return null;
    if (session.state === "deleting" || session.state === "suspending") {
      await sleep(pollMs);
      continue;
    }
    if (session.state === "running" && workspaceProviderRef(session)) {
      return session as DesktopSessionWithComputer;
    }
    if (session.state === "error") {
      throw new Error("Computer boot failed");
    }
    if (!session.state || (session.state !== "booting" && session.state !== "running")) {
      return null;
    }
    await sleep(pollMs);
  }
  return null;
}

export async function waitForComputerCleanupRelease(
  prisma: PrismaClient,
  workspaceId: string,
  options?: { timeoutMs?: number; pollMs?: number },
): Promise<ComputerRow | null> {
  const timeoutMs = options?.timeoutMs ?? DESKTOP_BOOT_WAIT_MS;
  const pollMs = options?.pollMs ?? DESKTOP_BOOT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const computer = await prisma.computer.findUnique({ where: { workspaceId } });
    if (!computer) return null;
    if (!computer.bootClaimToken) return computer as ComputerRow;
    await sleep(pollMs);
  }
  return null;
}

export async function claimComputerBoot(
  prisma: PrismaClient,
  workspaceId: string,
  now = new Date(),
): Promise<BootClaim | null> {
  await recoverStaleComputerSessionGate(prisma, workspaceId, now);
  const token = randomUUID();
  const stale = staleBefore(now);
  const claimed = await prisma.computer.updateMany({
    where: {
      workspaceId,
      OR: [
        { state: { in: [...BOOTABLE_COMPUTER_STATES] }, bootClaimToken: null },
        {
          state: { in: ["warming", "booting"] },
          OR: [{ bootClaimedAt: { lt: stale } }, { bootClaimedAt: null, updatedAt: { lt: stale } }],
        },
      ],
    },
    data: {
      state: "warming",
      bootClaimToken: token,
      bootClaimedAt: now,
    },
  });
  if (claimed.count !== 1) return null;
  return { token, claimedAt: now };
}

export async function renewComputerBootClaim(
  prisma: PrismaClient,
  workspaceId: string,
  token: string,
  now = new Date(),
): Promise<boolean> {
  const renewed = await prisma.computer.updateMany({
    where: {
      workspaceId,
      state: { in: ["warming", "booting"] },
      bootClaimToken: token,
    },
    data: { bootClaimedAt: now },
  });
  return renewed.count === 1;
}

export async function persistComputerBoot(
  prisma: PrismaClient,
  workspaceId: string,
  token: string,
  ref: Pick<ComputerRef, "kind" | "providerRef">,
): Promise<boolean> {
  const persisted = await prisma.computer.updateMany({
    where: {
      workspaceId,
      state: { in: ["warming", "booting"] },
      bootClaimToken: token,
    },
    data: {
      ...computerRunningDataFromProvision(ref),
      bootClaimToken: null,
      bootClaimedAt: null,
    },
  });
  return persisted.count === 1;
}

export async function releaseComputerBootFailure(
  prisma: PrismaClient,
  workspaceId: string,
  token: string,
  error?: unknown,
): Promise<boolean> {
  const message = error !== undefined ? bootErrorMessage(error) : undefined;
  const released = await prisma.computer.updateMany({
    where: {
      workspaceId,
      state: { in: ["warming", "booting"] },
      bootClaimToken: token,
    },
    data: {
      state: "error",
      bootClaimToken: null,
      bootClaimedAt: null,
      ...(message ? { bootLastError: message } : {}),
    },
  });
  return released.count === 1;
}

export async function recordComputerBootCleanupFailure(
  prisma: PrismaClient,
  workspaceId: string,
  token: string,
  error: unknown,
): Promise<void> {
  await prisma.computer.updateMany({
    where: { workspaceId, bootClaimToken: token },
    data: { bootLastError: bootErrorMessage(error) },
  });
}

export async function waitForComputerBoot(
  prisma: PrismaClient,
  workspaceId: string,
  options?: { timeoutMs?: number; pollMs?: number },
): Promise<ComputerRow | null> {
  const timeoutMs = options?.timeoutMs ?? DESKTOP_BOOT_WAIT_MS;
  const pollMs = options?.pollMs ?? DESKTOP_BOOT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const computer = await prisma.computer.findUnique({ where: { workspaceId } });
    if (!computer) return null;
    if (computer.state === "running" && computer.providerRef) {
      return computer as ComputerRow;
    }
    if (computer.state === "error") {
      throw new Error("Workspace computer warm failed");
    }
    if (
      computer.state !== "warming" &&
      computer.state !== "booting" &&
      computer.state !== "running"
    ) {
      return null;
    }
    await sleep(pollMs);
  }
  return null;
}
