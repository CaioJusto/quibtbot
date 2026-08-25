import { controlLeaseLive } from "@quibt/core";
import type { PrismaClient } from "@quibt/db";
import { describe, expect, it, vi } from "vitest";
import { reclaimComputerControlForBot } from "./executor.js";

interface SessionRow {
  botId: string;
  state: string;
  providerRef: string | null;
  display: number;
  controlHolder: string;
  controlLeaseId: string | null;
  controlLeaseUserId: string | null;
  controlLeaseExpiresAt: Date | null;
  controlFence: number;
}

type Where = Record<string, unknown>;

/** Enough of Prisma's matcher for the condition this reclaim depends on. */
function matches(row: SessionRow, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Where[]).some((clause) => matches(row, clause));
    const value = (row as unknown as Record<string, unknown>)[key];
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      const filter = condition as Record<string, unknown>;
      if ("not" in filter) return value !== filter.not;
      if ("lt" in filter) {
        if (!value) return false;
        return (value as Date).getTime() < (filter.lt as Date).getTime();
      }
      throw new Error(`unsupported filter ${JSON.stringify(filter)}`);
    }
    return value === condition;
  });
}

function sessionStore(row: SessionRow) {
  const prisma = {
    desktopSession: {
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<SessionRow> }) => {
        if (!matches(row, where)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
  };
  return { row, prisma: prisma as unknown as PrismaClient };
}

const now = new Date("2026-08-15T12:00:00.000Z");

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    botId: "bot-1",
    state: "running",
    providerRef: "container-1",
    display: 3,
    controlHolder: "none",
    controlLeaseId: null,
    controlLeaseUserId: null,
    controlLeaseExpiresAt: null,
    controlFence: 0,
    ...overrides,
  };
}

const liveLease = {
  controlHolder: "user",
  controlLeaseId: "ctl_live",
  controlLeaseUserId: "user-1",
  controlLeaseExpiresAt: new Date(now.getTime() + 60_000),
  controlFence: 4,
};

describe("reclaimComputerControlForBot", () => {
  it("leaves the keyboard with the member who holds a live takeover", async () => {
    const store = sessionStore(session(liveLease));
    expect(await reclaimComputerControlForBot(store.prisma, "bot-1", now)).toBe(false);
    expect(store.row).toMatchObject({
      controlHolder: "user",
      controlLeaseId: "ctl_live",
      controlLeaseUserId: "user-1",
    });
    // Booting the computer still applied everything that is not about control.
    expect(store.row).toMatchObject({ state: "running", providerRef: "container-1", display: 3 });
  });

  it("takes control back once the lease has expired", async () => {
    const store = sessionStore(
      session({ ...liveLease, controlLeaseExpiresAt: new Date(now.getTime() - 1) }),
    );
    expect(await reclaimComputerControlForBot(store.prisma, "bot-1", now)).toBe(true);
    expect(store.row).toMatchObject({
      controlHolder: "bot",
      controlLeaseId: null,
      controlLeaseUserId: null,
      controlLeaseExpiresAt: null,
    });
  });

  it("keeps the old behaviour when nobody is at the screen", async () => {
    const store = sessionStore(session());
    expect(await reclaimComputerControlForBot(store.prisma, "bot-1", now)).toBe(true);
    expect(store.row.controlHolder).toBe("bot");
  });

  it("only spares the sessions @quibt/core calls live", async () => {
    const shapes: SessionRow[] = [
      session(),
      session({ controlHolder: "bot" }),
      session(liveLease),
      session({ ...liveLease, controlLeaseExpiresAt: new Date(now.getTime() - 1) }),
      // Legacy row: took the keyboard before deadlines were persisted.
      session({ ...liveLease, controlLeaseExpiresAt: null }),
    ];
    for (const shape of shapes) {
      // Read the verdict before the reclaim: the update mutates the row in place.
      const live = controlLeaseLive(shape, now);
      const store = sessionStore(shape);
      const reclaimed = await reclaimComputerControlForBot(store.prisma, "bot-1", now);
      expect(reclaimed).toBe(!live);
      expect(store.row.controlHolder).toBe(live ? "user" : "bot");
    }
  });
});
