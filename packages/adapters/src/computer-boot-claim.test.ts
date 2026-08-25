import type { PrismaClient } from "@quibt/db";
import { describe, expect, it, vi } from "vitest";
import {
  claimComputerBoot,
  claimDesktopBoot,
  DESKTOP_BOOT_STALE_MS,
  persistComputerBoot,
  persistDesktopBoot,
  recordComputerBootCleanupFailure,
  recordDesktopBootCleanupFailure,
  releaseComputerBootFailure,
  releaseDesktopBootFailure,
  renewDesktopBootClaim,
  waitForDesktopBoot,
  withBootClaimHeartbeat,
} from "./computer-boot-claim.js";
import { recordOrphanProvisionForReconciliation } from "./computer-boot-provision.js";

type SessionRow = {
  botId: string;
  computerId: string;
  display: number;
  providerRef: string | null;
  screenUrl: string | null;
  state: string;
  updatedAt: Date;
  bootClaimToken: string | null;
  bootClaimedAt: Date | null;
  bootLastError: string | null;
  controlHolder: string;
  computer: { id: string; kind: string; providerRef: string | null };
};

type ComputerRow = {
  id: string;
  workspaceId: string;
  kind: string;
  providerRef: string | null;
  state: string;
  updatedAt: Date;
  bootClaimToken: string | null;
  bootClaimedAt: Date | null;
  bootLastError: string | null;
};

function createSessionRow(kind = "docker"): SessionRow {
  return {
    botId: "bot-a",
    computerId: "comp-1",
    display: 1,
    providerRef: null,
    screenUrl: null,
    state: "stopped",
    updatedAt: new Date(),
    bootClaimToken: null,
    bootClaimedAt: null,
    bootLastError: null,
    controlHolder: "none",
    computer: { id: "comp-1", kind, providerRef: null },
  };
}

function createComputerRow(workspaceId = "ws-1", kind = "docker"): ComputerRow {
  return {
    id: "comp-1",
    workspaceId,
    kind,
    providerRef: null,
    state: "stopped",
    updatedAt: new Date(),
    bootClaimToken: null,
    bootClaimedAt: null,
    bootLastError: null,
  };
}

function staleBefore(now: Date): Date {
  return new Date(now.getTime() - DESKTOP_BOOT_STALE_MS);
}

function desktopClaimable(session: SessionRow, now: Date): boolean {
  const stale = staleBefore(now);
  return (
    session.state === "stopped" ||
    session.state === "error" ||
    session.state === "suspended" ||
    (session.state === "booting" &&
      ((session.bootClaimedAt !== null && session.bootClaimedAt < stale) ||
        (session.bootClaimedAt === null && session.updatedAt < stale)))
  );
}

function _computerClaimable(computer: ComputerRow, now: Date): boolean {
  const stale = staleBefore(now);
  if (
    computer.state === "stopped" ||
    computer.state === "error" ||
    computer.state === "suspended"
  ) {
    return true;
  }
  if (computer.state === "warming" || computer.state === "booting") {
    return (
      (computer.bootClaimedAt !== null && computer.bootClaimedAt < stale) ||
      (computer.bootClaimedAt === null && computer.updatedAt < stale)
    );
  }
  return false;
}

function createDesktopPrisma(session: SessionRow) {
  const desktopSession = {
    findUnique: async () => session,
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      const now = new Date();
      if (where.botId === session.botId && data.bootClaimToken && data.state === "booting") {
        if (desktopClaimable(session, now)) {
          Object.assign(session, data);
          session.updatedAt = now;
          return { count: 1 };
        }
        return { count: 0 };
      }
      if (
        where.botId === session.botId &&
        where.bootClaimToken === session.bootClaimToken &&
        data.bootClaimedAt
      ) {
        session.bootClaimedAt = data.bootClaimedAt as Date;
        session.updatedAt = now;
        return { count: 1 };
      }
      if (where.botId === session.botId && where.bootClaimToken === session.bootClaimToken) {
        Object.assign(session, data);
        session.updatedAt = now;
        return { count: 1 };
      }
      return { count: 0 };
    },
    update: async () => session,
  };
  const computer = {
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (data.providerRef !== undefined) {
        session.computer.providerRef = data.providerRef as string | null;
      }
      return session.computer;
    }),
  };
  const prisma = {
    desktopSession,
    computer,
    $transaction: vi.fn(async (cb: (tx: typeof prisma) => Promise<boolean>) => cb(prisma)),
  };
  return { prisma: prisma as unknown as PrismaClient, session };
}

function matchesStaleClaim(
  row: { bootClaimedAt: Date | null; updatedAt: Date },
  stale: Date,
): boolean {
  return (
    (row.bootClaimedAt !== null && row.bootClaimedAt < stale) ||
    (row.bootClaimedAt === null && row.updatedAt < stale)
  );
}

function matchesComputerBootClaimWhere(
  computer: ComputerRow,
  where: Record<string, unknown>,
  now: Date,
): boolean {
  if (where.workspaceId !== computer.workspaceId) return false;
  const _stale = staleBefore(now);
  const orClauses = where.OR as Array<Record<string, unknown>> | undefined;
  if (!orClauses) return false;
  return orClauses.some((clause) => {
    const stateIn = (clause.state as { in?: string[] } | undefined)?.in;
    if (!stateIn?.includes(computer.state)) return false;
    if (stateIn.includes("stopped") || stateIn.includes("error") || stateIn.includes("suspended")) {
      return clause.bootClaimToken === null && computer.bootClaimToken === null;
    }
    if (stateIn.includes("warming") || stateIn.includes("booting")) {
      const nested = clause.OR as Array<Record<string, unknown>> | undefined;
      return nested?.some((nestedClause) => {
        const lt = (nestedClause.bootClaimedAt as { lt?: Date } | undefined)?.lt;
        if (lt) return computer.bootClaimedAt !== null && computer.bootClaimedAt < lt;
        const updatedLt = (nestedClause.updatedAt as { lt?: Date } | undefined)?.lt;
        return (
          nestedClause.bootClaimedAt === null &&
          updatedLt !== undefined &&
          computer.bootClaimedAt === null &&
          computer.updatedAt < updatedLt
        );
      });
    }
    return false;
  });
}

function createComputerPrisma(computer: ComputerRow) {
  const prisma = {
    computer: {
      findUnique: async () => computer,
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const now = new Date();
        const stale = staleBefore(now);
        if (where.workspaceId === computer.workspaceId) {
          if (
            data.bootClaimToken &&
            data.state === "warming" &&
            matchesComputerBootClaimWhere(computer, where, now)
          ) {
            Object.assign(computer, data);
            computer.updatedAt = now;
            return { count: 1 };
          }
          const gateToken = where.bootClaimToken as { not?: null } | undefined;
          const stateNotIn = (where.state as { notIn?: string[] } | undefined)?.notIn;
          if (
            gateToken?.not === null &&
            computer.bootClaimToken !== null &&
            !stateNotIn?.includes(computer.state) &&
            matchesStaleClaim(computer, stale)
          ) {
            Object.assign(computer, data);
            computer.updatedAt = now;
            return { count: 1 };
          }
        }
        if (
          where.workspaceId === computer.workspaceId &&
          where.bootClaimToken === computer.bootClaimToken
        ) {
          Object.assign(computer, data);
          computer.updatedAt = now;
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
  };
  return { prisma: prisma as unknown as PrismaClient, computer };
}

describe("claimDesktopBoot fencing", () => {
  it("returns a unique token and only one concurrent claim wins", async () => {
    const { prisma, session } = createDesktopPrisma(createSessionRow());
    const [first, second] = await Promise.all([
      claimDesktopBoot(prisma, session.botId),
      claimDesktopBoot(prisma, session.botId),
    ]);
    const winner = first ?? second;
    const loser = first ? second : first;
    expect(winner).not.toBeNull();
    expect(loser).toBeNull();
    expect(session.bootClaimToken).toBe(winner!.token);
    expect(session.state).toBe("booting");
  });

  it("steals a stale claim with a new token", async () => {
    const session = createSessionRow();
    session.state = "booting";
    session.bootClaimToken = "stale-token";
    session.bootClaimedAt = new Date(Date.now() - DESKTOP_BOOT_STALE_MS - 1);
    const { prisma } = createDesktopPrisma(session);
    const stolen = await claimDesktopBoot(prisma, session.botId);
    expect(stolen).not.toBeNull();
    expect(stolen!.token).not.toBe("stale-token");
    expect(session.bootClaimToken).toBe(stolen!.token);
  });

  it("loser cannot persist or release after steal; winner persists", async () => {
    const session = createSessionRow();
    const { prisma } = createDesktopPrisma(session);
    const loserClaim = await claimDesktopBoot(prisma, session.botId);
    expect(loserClaim).not.toBeNull();

    session.bootClaimedAt = new Date(Date.now() - DESKTOP_BOOT_STALE_MS - 1);
    const winnerClaim = await claimDesktopBoot(prisma, session.botId);
    expect(winnerClaim).not.toBeNull();
    expect(winnerClaim!.token).not.toBe(loserClaim!.token);

    const loserPersisted = await persistDesktopBoot(prisma, {
      botId: session.botId,
      computerId: session.computerId,
      token: loserClaim!.token,
      ref: {
        kind: "docker",
        providerRef: "orphan-ref",
        screenUrl: "https://orphan",
        display: 1,
      },
      existing: session,
    });
    expect(loserPersisted).toBe(false);
    expect(session.bootClaimToken).toBe(winnerClaim!.token);

    const loserReleased = await releaseDesktopBootFailure(
      prisma,
      session.botId,
      loserClaim!.token,
      "loser failure",
    );
    expect(loserReleased).toBe(false);
    expect(session.state).toBe("booting");

    await recordDesktopBootCleanupFailure(
      prisma,
      session.botId,
      loserClaim!.token,
      "cleanup telemetry",
    );
    expect(session.bootLastError).toBeNull();

    const winnerPersisted = await persistDesktopBoot(prisma, {
      botId: session.botId,
      computerId: session.computerId,
      token: winnerClaim!.token,
      ref: {
        kind: "docker",
        providerRef: "container-workspace",
        screenUrl: "https://screen",
        display: 1,
      },
      existing: session,
    });
    expect(winnerPersisted).toBe(true);
    expect(session.state).toBe("running");
    expect(session.bootClaimToken).toBeNull();
  });

  it("records cleanup telemetry only for the matching token", async () => {
    const session = createSessionRow();
    session.state = "booting";
    session.bootClaimToken = "winner-token";
    session.bootLastError = null;
    const { prisma } = createDesktopPrisma(session);

    await recordDesktopBootCleanupFailure(prisma, session.botId, "other-token", "ignored");
    expect(session.bootLastError).toBeNull();

    await recordDesktopBootCleanupFailure(prisma, session.botId, "winner-token", "cleanup failed");
    expect(session.bootLastError).toBe("cleanup failed");
    expect(session.bootClaimToken).toBe("winner-token");
  });
});

describe("withBootClaimHeartbeat", () => {
  it("renews claim during a slow provision", async () => {
    const session = createSessionRow();
    const { prisma } = createDesktopPrisma(session);
    const claim = await claimDesktopBoot(prisma, session.botId);
    expect(claim).not.toBeNull();

    const before = session.bootClaimedAt;
    await withBootClaimHeartbeat(
      () => renewDesktopBootClaim(prisma, session.botId, claim!.token),
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
      },
      { intervalMs: 10 },
    );
    expect(session.bootClaimedAt!.getTime()).toBeGreaterThanOrEqual(before!.getTime());
  });
});

describe("waitForDesktopBoot", () => {
  it("returns when another worker finishes booting", async () => {
    const session = createSessionRow();
    session.state = "booting";
    const { prisma } = createDesktopPrisma(session);
    const waited = waitForDesktopBoot(prisma, session.botId, {
      timeoutMs: 500,
      pollMs: 10,
    });
    setTimeout(() => {
      session.state = "running";
      session.providerRef = "container-workspace";
      session.computer.providerRef = "container-workspace";
      session.screenUrl = "https://screen.test";
      session.bootClaimToken = null;
    }, 30);
    const result = await waited;
    expect(result?.state).toBe("running");
  });
});

describe("claimComputerBoot fencing", () => {
  it("only one workspace warm claim wins concurrently", async () => {
    const computer = createComputerRow();
    const { prisma } = createComputerPrisma(computer);
    const [first, second] = await Promise.all([
      claimComputerBoot(prisma, computer.workspaceId),
      claimComputerBoot(prisma, computer.workspaceId),
    ]);
    expect(Boolean(first) && Boolean(second)).toBe(false);
    const winner = first ?? second;
    expect(winner).not.toBeNull();
    expect(computer.bootClaimToken).toBe(winner!.token);
    expect(computer.state).toBe("warming");
  });

  it("persists with CAS on boot claim token", async () => {
    const computer = createComputerRow();
    const { prisma } = createComputerPrisma(computer);
    const claim = await claimComputerBoot(prisma, computer.workspaceId);
    expect(claim).not.toBeNull();

    const lost = await persistComputerBoot(prisma, computer.workspaceId, "wrong-token", {
      kind: "docker",
      providerRef: "wrong",
    });
    expect(lost).toBe(false);

    const ok = await persistComputerBoot(prisma, computer.workspaceId, claim!.token, {
      kind: "docker",
      providerRef: "container-workspace",
    });
    expect(ok).toBe(true);
    expect(computer.state).toBe("running");
    expect(computer.bootClaimToken).toBeNull();
  });

  it("records computer cleanup failure without overwriting a stolen claim", async () => {
    const computer = createComputerRow();
    const { prisma } = createComputerPrisma(computer);
    const first = await claimComputerBoot(prisma, computer.workspaceId);
    computer.bootClaimedAt = new Date(Date.now() - DESKTOP_BOOT_STALE_MS - 1);
    const second = await claimComputerBoot(prisma, computer.workspaceId);
    expect(second!.token).not.toBe(first!.token);

    await recordComputerBootCleanupFailure(
      prisma,
      computer.workspaceId,
      first!.token,
      "orphan cleanup",
    );
    expect(computer.bootLastError).toBeNull();

    const released = await releaseComputerBootFailure(
      prisma,
      computer.workspaceId,
      second!.token,
      "winner error",
    );
    expect(released).toBe(true);
    expect(computer.bootLastError).toBe("winner error");
  });

  it("requires bootClaimToken null for bootable computer states", async () => {
    const computer = createComputerRow();
    computer.bootClaimToken = "session-gate";
    const { prisma } = createComputerPrisma(computer);
    expect(await claimComputerBoot(prisma, computer.workspaceId)).toBeNull();
    expect(computer.bootClaimToken).toBe("session-gate");
  });

  it("records orphan provision after stale steal without matching claim token", async () => {
    const computer = createComputerRow();
    const { prisma } = createComputerPrisma(computer);
    const first = await claimComputerBoot(prisma, computer.workspaceId);
    computer.bootClaimedAt = new Date(Date.now() - DESKTOP_BOOT_STALE_MS - 1);
    const second = await claimComputerBoot(prisma, computer.workspaceId);
    expect(second!.token).not.toBe(first!.token);

    const create = vi.fn(async () => ({}));
    Object.assign(prisma, { orphanProvision: { create } });

    await recordOrphanProvisionForReconciliation(prisma as never, {
      workspaceId: computer.workspaceId,
      ref: {
        id: "orphan",
        botId: "workspace",
        kind: "docker",
        providerRef: "stale-orphan-ref",
      },
      reason: "stale steal orphan cleanup",
    });

    expect(create).toHaveBeenCalledOnce();
    expect(computer.bootLastError).toBeNull();
  });
});
