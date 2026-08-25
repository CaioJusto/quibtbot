import type { PrismaClient } from "@quibt/db";
import { describe, expect, it } from "vitest";
import { claimDesktopBoot } from "./computer-boot-claim.js";
import {
  claimComputerSessionStartGate,
  claimDesktopDelete,
  claimDesktopSuspend,
  decodeLifecycleRestoreState,
  encodeLifecycleRestoreState,
  finalizeDesktopDelete,
  finalizeDesktopSuspended,
  isDesktopBootBlocked,
  recoverStaleDesktopDelete,
  recoverStaleDesktopSuspend,
  recoverStaleDesktopSuspendForBoot,
  releaseComputerSessionStartGate,
  releaseDesktopSuspendClaim,
  validateComputerSessionStartGate,
  validateDesktopDeleteClaim,
  validateDesktopSuspendClaim,
} from "./session-lifecycle.js";

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
  controlLeaseId: string | null;
  controlLeaseUserId: string | null;
  controlLeaseExpiresAt: Date | null;
  computer: { id: string; kind: string; providerRef: string | null };
};

function createSessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    botId: "bot-a",
    computerId: "comp-1",
    display: 1,
    providerRef: "box-a",
    screenUrl: null,
    state: "running",
    updatedAt: new Date(),
    bootClaimToken: null,
    bootClaimedAt: null,
    bootLastError: null,
    controlHolder: "none",
    controlLeaseId: null,
    controlLeaseUserId: null,
    controlLeaseExpiresAt: null,
    computer: { id: "comp-1", kind: "box", providerRef: null },
    ...overrides,
  };
}

function matchesNotUser(session: SessionRow, where: Record<string, unknown>): boolean {
  const holder = where.controlHolder as { not?: string } | undefined;
  if (holder?.not === "user" && session.controlHolder === "user") return false;
  return true;
}

function createPrisma(session: SessionRow) {
  const prisma = {
    desktopSession: {
      findUnique: async () => session,
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (where.botId !== session.botId) return { count: 0 };
        if (!matchesNotUser(session, where)) return { count: 0 };
        if (where.state === "running" && session.state !== "running") return { count: 0 };
        if (where.state === "suspending") {
          if (session.state !== "suspending") return { count: 0 };
          if (where.bootClaimToken && session.bootClaimToken !== where.bootClaimToken) {
            return { count: 0 };
          }
        }
        if (where.state === "deleting") {
          if (session.state !== "deleting") return { count: 0 };
          if (where.bootClaimToken && session.bootClaimToken !== where.bootClaimToken) {
            return { count: 0 };
          }
        }
        if (
          where.state &&
          typeof where.state === "object" &&
          "in" in where.state &&
          Array.isArray((where.state as { in: string[] }).in) &&
          !(where.state as { in: string[] }).in.includes(session.state)
        ) {
          return { count: 0 };
        }
        if (where.bootClaimToken === null && session.bootClaimToken !== null) return { count: 0 };
        if (
          typeof where.bootClaimToken === "string" &&
          session.bootClaimToken !== where.bootClaimToken
        ) {
          return { count: 0 };
        }
        if (Array.isArray(where.OR)) {
          const stale = (where.OR as Array<Record<string, unknown>>).some((clause) => {
            if (clause.bootClaimedAt === null) {
              const updatedAt = clause.updatedAt as { lt?: Date } | undefined;
              return (
                session.bootClaimedAt === null &&
                updatedAt?.lt instanceof Date &&
                session.updatedAt < updatedAt.lt
              );
            }
            const bootClaimedAt = clause.bootClaimedAt as { lt?: Date } | undefined;
            return (
              bootClaimedAt?.lt instanceof Date &&
              session.bootClaimedAt !== null &&
              session.bootClaimedAt < bootClaimedAt.lt
            );
          });
          if (!stale) return { count: 0 };
        }
        if (where.state && (where.state as { notIn?: string[] }).notIn?.includes(session.state)) {
          return { count: 0 };
        }
        Object.assign(session, data);
        return { count: 1 };
      },
    },
  };
  return { prisma: prisma as unknown as PrismaClient, session };
}

describe("session lifecycle claims", () => {
  it("claims running session for suspend with a fencing token", async () => {
    const { prisma, session } = createPrisma(createSessionRow());
    const claim = await claimDesktopSuspend(prisma, session.botId);
    expect(claim).not.toBeNull();
    expect(session.state).toBe("suspending");
    expect(session.bootClaimToken).toBe(claim!.token);
  });

  it("refuses suspend while user holds control", async () => {
    const { prisma } = createPrisma(createSessionRow({ controlHolder: "user" }));
    expect(await claimDesktopSuspend(prisma, "bot-a")).toBeNull();
  });

  it("finalizes suspended only with matching token", async () => {
    const { prisma, session } = createPrisma(createSessionRow());
    const claim = await claimDesktopSuspend(prisma, session.botId);
    expect(await finalizeDesktopSuspended(prisma, session.botId, "wrong")).toBe(false);
    expect(await finalizeDesktopSuspended(prisma, session.botId, claim!.token)).toBe(true);
    expect(session.state).toBe("suspended");
    expect(session.bootClaimToken).toBeNull();
  });

  it("validates suspend token immediately before provider stop", async () => {
    const { prisma, session } = createPrisma(createSessionRow());
    const claim = await claimDesktopSuspend(prisma, session.botId);
    expect(await validateDesktopSuspendClaim(prisma, session.botId, claim!.token)).toBe(true);
    session.controlHolder = "user";
    expect(await validateDesktopSuspendClaim(prisma, session.botId, claim!.token)).toBe(false);
  });

  it("releases suspend claim when boot wins the race", async () => {
    const { prisma, session } = createPrisma(createSessionRow());
    const claim = await claimDesktopSuspend(prisma, session.botId);
    session.state = "running";
    session.bootClaimToken = "boot-token";
    expect(await releaseDesktopSuspendClaim(prisma, session.botId, claim!.token)).toBe(false);
    session.state = "suspending";
    session.bootClaimToken = claim!.token;
    expect(await releaseDesktopSuspendClaim(prisma, session.botId, claim!.token)).toBe(true);
    expect(session.state).toBe("running");
  });

  it("blocks boot while suspending or deleting", () => {
    expect(isDesktopBootBlocked("suspending")).toBe(true);
    expect(isDesktopBootBlocked("deleting")).toBe(true);
    expect(isDesktopBootBlocked("suspended")).toBe(false);
  });

  it("refuses boot while session is deleting", async () => {
    const { prisma, session } = createPrisma(
      createSessionRow({ state: "deleting", bootClaimToken: "delete-token" }),
    );
    expect(await claimDesktopBoot(prisma, session.botId)).toBeNull();
  });

  it("keeps providerRef during delete claim until finalize", async () => {
    const { prisma, session } = createPrisma(createSessionRow({ providerRef: "box-a" }));
    const claim = await claimDesktopDelete(prisma, session.botId);
    expect(claim).not.toBeNull();
    expect(session.state).toBe("deleting");
    expect(session.providerRef).toBe("box-a");
    expect(await validateDesktopDeleteClaim(prisma, session.botId, claim!.token)).toBe("valid");
    expect(await finalizeDesktopDelete(prisma, session.botId, claim!.token)).toBe(true);
    expect(session.providerRef).toBeNull();
  });

  it("recovers stale suspending claims to running for stop retry", async () => {
    const stale = new Date(Date.now() - 200_000);
    const { prisma, session } = createPrisma(
      createSessionRow({
        state: "suspending",
        bootClaimToken: "old",
        bootClaimedAt: stale,
      }),
    );
    expect(await recoverStaleDesktopSuspend(prisma, session.botId)).toBe(true);
    expect(session.state).toBe("running");
    expect(session.bootClaimToken).toBeNull();
  });

  it("a boot recovers a stale suspending session to suspended", async () => {
    // O sono foi interrompido no meio (worker reiniciado numa atualização): a linha ficava
    // em "suspending" para sempre e o boot nunca pegava. "suspended" é o estado seguro
    // para ligar a tela: o start do Xvfb responde "already-running" se ele ainda vive.
    const stale = new Date(Date.now() - 200_000);
    const { prisma, session } = createPrisma(
      createSessionRow({
        state: "suspending",
        bootClaimToken: "old",
        bootClaimedAt: stale,
      }),
    );
    expect(await recoverStaleDesktopSuspendForBoot(prisma, session.botId)).toBe(true);
    expect(session.state).toBe("suspended");
    expect(session.bootClaimToken).toBeNull();
    expect(session.controlHolder).toBe("none");
  });

  it("a boot does not touch a suspend that is still in flight", async () => {
    const { prisma, session } = createPrisma(
      createSessionRow({ state: "suspending", bootClaimToken: "live", bootClaimedAt: new Date() }),
    );
    expect(await recoverStaleDesktopSuspendForBoot(prisma, session.botId)).toBe(false);
    expect(session.state).toBe("suspending");
  });

  it("recovers stale deleting claims to retryable state while keeping providerRef", async () => {
    const stale = new Date(Date.now() - 200_000);
    const { prisma, session } = createPrisma(
      createSessionRow({
        state: "deleting",
        providerRef: "box-a",
        bootClaimToken: "old-delete",
        bootClaimedAt: stale,
        bootLastError: encodeLifecycleRestoreState("running"),
      }),
    );
    expect(await recoverStaleDesktopDelete(prisma, session.botId)).toBe(true);
    expect(session.state).toBe("running");
    expect(session.providerRef).toBe("box-a");
    expect(session.bootClaimToken).toBeNull();
    expect(decodeLifecycleRestoreState(session.bootLastError)).toBe("running");
  });

  it("reclaims delete after stale recovery and retries destroy", async () => {
    const stale = new Date(Date.now() - 200_000);
    const { prisma, session } = createPrisma(
      createSessionRow({
        state: "deleting",
        providerRef: "box-a",
        bootClaimToken: "stale",
        bootClaimedAt: stale,
        bootLastError: encodeLifecycleRestoreState("error"),
      }),
    );
    await recoverStaleDesktopDelete(prisma, session.botId);
    const claim = await claimDesktopDelete(prisma, session.botId);
    expect(claim).not.toBeNull();
    expect(session.state).toBe("deleting");
    expect(session.providerRef).toBe("box-a");
    expect(await validateDesktopDeleteClaim(prisma, session.botId, claim!.token)).toBe("valid");
    expect(await finalizeDesktopDelete(prisma, session.botId, claim!.token)).toBe(true);
    expect(session.providerRef).toBeNull();
  });
});

type ComputerRow = {
  workspaceId: string;
  state: string;
  bootClaimToken: string | null;
  bootClaimedAt: Date | null;
  updatedAt: Date;
};

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
        if (where.workspaceId !== computer.workspaceId) return { count: 0 };
        if (where.bootClaimToken === null && computer.bootClaimToken !== null) return { count: 0 };
        if (
          typeof where.bootClaimToken === "string" &&
          computer.bootClaimToken !== where.bootClaimToken
        ) {
          return { count: 0 };
        }
        const stateNotIn = (where.state as { notIn?: string[] } | undefined)?.notIn;
        if (stateNotIn?.includes(computer.state)) return { count: 0 };
        if (where.bootClaimToken && typeof where.bootClaimToken === "object") {
          const not = (where.bootClaimToken as { not?: null }).not;
          if (not === null && computer.bootClaimToken === null) return { count: 0 };
        }
        if (Array.isArray(where.OR) && computer.bootClaimToken) {
          const stale = (where.OR as Array<{ bootClaimedAt?: { lt?: Date } }>).some((clause) => {
            const lt = clause.bootClaimedAt?.lt;
            return lt && computer.bootClaimedAt && computer.bootClaimedAt < lt;
          });
          if (!stale) return { count: 0 };
        }
        Object.assign(computer, data);
        return { count: 1 };
      },
    },
  };
  return { prisma: prisma as unknown as PrismaClient, computer };
}

describe("computer session-start gate", () => {
  it("serializes shared boot connect and delete via the same gate token", async () => {
    const { prisma, computer } = createComputerPrisma({
      workspaceId: "ws-1",
      state: "running",
      bootClaimToken: null,
      bootClaimedAt: null,
      updatedAt: new Date(),
    });
    const bootGate = await claimComputerSessionStartGate(prisma, computer.workspaceId);
    expect(bootGate).not.toBeNull();
    expect(await claimComputerSessionStartGate(prisma, computer.workspaceId)).toBeNull();
    expect(
      await validateComputerSessionStartGate(prisma, computer.workspaceId, bootGate!.token),
    ).toBe(true);
    expect(
      await releaseComputerSessionStartGate(prisma, computer.workspaceId, bootGate!.token),
    ).toBe(true);
    const deleteGate = await claimComputerSessionStartGate(prisma, computer.workspaceId);
    expect(deleteGate).not.toBeNull();
  });
});
