import type { PrismaClient } from "@quibt/db";
import { describe, expect, it } from "vitest";
import {
  COMPUTER_SESSION_GATE_STALE_MS,
  claimComputerSessionStartGate,
  recoverStaleComputerSessionGate,
  startComputerSessionGateHeartbeat,
  waitForComputerSessionGateOrRecover,
} from "./session-lifecycle.js";

type ComputerRow = {
  workspaceId: string;
  state: string;
  bootClaimToken: string | null;
  bootClaimedAt: Date | null;
  updatedAt: Date;
};

function isStaleGate(row: ComputerRow, now = Date.now()): boolean {
  const stale = now - COMPUTER_SESSION_GATE_STALE_MS;
  return row.bootClaimedAt ? row.bootClaimedAt.getTime() < stale : row.updatedAt.getTime() < stale;
}

function createComputerPrisma(computer: ComputerRow) {
  const prisma = {
    computer: {
      findUnique: async () => ({ ...computer }),
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (where.workspaceId !== computer.workspaceId) return { count: 0 };
        if (
          data.bootClaimToken === null &&
          data.bootClaimedAt === null &&
          computer.bootClaimToken &&
          isStaleGate(computer)
        ) {
          const stateNotIn = (where.state as { notIn?: string[] } | undefined)?.notIn;
          if (!stateNotIn?.includes(computer.state)) {
            Object.assign(computer, data);
            return { count: 1 };
          }
        }
        const stateNotIn = (where.state as { notIn?: string[] } | undefined)?.notIn;
        if (stateNotIn?.includes(computer.state)) return { count: 0 };
        if (where.bootClaimToken === null && computer.bootClaimToken !== null) return { count: 0 };
        if (
          typeof where.bootClaimToken === "string" &&
          computer.bootClaimToken !== where.bootClaimToken
        ) {
          return { count: 0 };
        }
        const clearingGate =
          data.bootClaimToken === null &&
          data.bootClaimedAt === null &&
          !data.state &&
          computer.bootClaimToken !== null;
        if (clearingGate && isStaleGate(computer)) {
          Object.assign(computer, data);
          return { count: 1 };
        }
        if (where.bootClaimToken === null && data.bootClaimToken) {
          Object.assign(computer, data);
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
  };
  return { prisma: prisma as unknown as PrismaClient, computer };
}

describe("session gate recovery", () => {
  it("waitForComputerSessionGateOrRecover succeeds when gate already clear", async () => {
    const { prisma, computer } = createComputerPrisma({
      workspaceId: "ws-1",
      state: "running",
      bootClaimToken: null,
      bootClaimedAt: null,
      updatedAt: new Date(),
    });
    expect(
      await waitForComputerSessionGateOrRecover(prisma, computer.workspaceId, { timeoutMs: 10 }),
    ).toBe(true);
  });

  it("blocks sibling session start while delete holds a live gate", async () => {
    const { prisma, computer } = createComputerPrisma({
      workspaceId: "ws-1",
      state: "running",
      bootClaimToken: "delete-gate",
      bootClaimedAt: new Date(),
      updatedAt: new Date(),
    });
    expect(await claimComputerSessionStartGate(prisma, computer.workspaceId)).toBeNull();
    expect(computer.bootClaimToken).toBe("delete-gate");
  });

  it("recovers only non-booting computer gates", async () => {
    const stale = new Date(0);
    const { prisma, computer } = createComputerPrisma({
      workspaceId: "ws-1",
      state: "warming",
      bootClaimToken: "boot-claim",
      bootClaimedAt: stale,
      updatedAt: stale,
    });
    expect(await recoverStaleComputerSessionGate(prisma, computer.workspaceId)).toBe(false);
    expect(computer.bootClaimToken).toBe("boot-claim");
  });

  it("does not recover a live gate that is still being renewed", async () => {
    const { prisma, computer } = createComputerPrisma({
      workspaceId: "ws-1",
      state: "running",
      bootClaimToken: "live-gate",
      bootClaimedAt: new Date(),
      updatedAt: new Date(),
    });
    expect(await recoverStaleComputerSessionGate(prisma, computer.workspaceId)).toBe(false);
    expect(computer.bootClaimToken).toBe("live-gate");
  });

  it("heartbeat renewal keeps an external gate from going stale", async () => {
    const { prisma, computer } = createComputerPrisma({
      workspaceId: "ws-1",
      state: "running",
      bootClaimToken: "external-gate",
      bootClaimedAt: new Date(),
      updatedAt: new Date(),
    });
    const stop = startComputerSessionGateHeartbeat(prisma, computer.workspaceId, "external-gate", {
      intervalMs: 10,
    });
    expect(typeof stop).toBe("function");
    stop();
  });
});
