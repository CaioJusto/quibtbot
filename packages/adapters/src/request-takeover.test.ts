import { describe, expect, it, vi } from "vitest";
import { lockComputerForAgent } from "./executor.js";
import {
  agentComputerUseAllowed,
  applyRequestTakeover,
  clearWaitingTakeover,
  parkedDesktopForTakeover,
  takeoverNotice,
} from "./request-takeover.js";

const now = new Date("2026-09-02T12:00:00.000Z");

function memoryComputer() {
  const session = {
    botId: "bot-1",
    state: "running",
    controlHolder: "bot",
    controlFence: 4,
    waitingTakeover: false,
  };
  const run = {
    id: "run-1",
    status: "running",
    leaseOwner: "worker-1",
    leaseFence: 2,
    leaseExpiresAt: new Date(now.getTime() + 60_000),
    workspaceId: "ws-1",
    userId: "user-1",
    botId: "bot-1",
    threadId: "thr-1",
  };
  const notifications = { send: vi.fn(async () => undefined) };
  const prisma = {
    desktopSession: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { botId?: string; state?: string; controlHolder?: string; controlFence?: number };
        data: Record<string, unknown>;
      }) => {
        if (where.botId && where.botId !== session.botId) return { count: 0 };
        if (where.state && where.state !== session.state) return { count: 0 };
        if (where.controlHolder && where.controlHolder !== session.controlHolder) {
          return { count: 0 };
        }
        if (where.controlFence !== undefined && where.controlFence !== session.controlFence) {
          return { count: 0 };
        }
        Object.assign(session, data);
        return { count: 1 };
      },
      findUnique: async ({ where }: { where: { botId: string } }) =>
        where.botId === session.botId
          ? {
              state: session.state,
              controlFence: session.controlFence,
              controlHolder: session.controlHolder,
              waitingTakeover: session.waitingTakeover,
            }
          : null,
    },
    run: {
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        if (where.id !== run.id) return null;
        Object.assign(run, data);
        return run;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (where.id && where.id !== run.id) return { count: 0 };
        if (where.status && where.status !== run.status) return { count: 0 };
        if (where.leaseOwner && where.leaseOwner !== run.leaseOwner) return { count: 0 };
        if (where.leaseFence !== undefined && where.leaseFence !== run.leaseFence) {
          return { count: 0 };
        }
        const expiry = where.leaseExpiresAt as { gt?: Date } | undefined;
        if (expiry?.gt && run.leaseExpiresAt.getTime() <= expiry.gt.getTime()) {
          return { count: 0 };
        }
        Object.assign(run, data);
        return { count: 1 };
      },
    },
  };
  return { session, run, notifications, prisma };
}

describe("request_takeover", () => {
  it("parks the computer session in waiting_takeover", () => {
    expect(parkedDesktopForTakeover()).toEqual({
      state: "running",
      controlHolder: "none",
      waitingTakeover: true,
    });
  });

  it("writes waiting_takeover and invokes the notification hook", async () => {
    const { session, run, notifications, prisma } = memoryComputer();
    const result = await applyRequestTakeover({
      prisma,
      notifications,
      bot: { id: "bot-1", name: "Finn" },
      run,
      reason: "preciso que você faça o login no banco",
    });

    expect(result).toEqual({ status: "waiting_takeover" });
    expect(run.status).toBe("waiting_takeover");
    expect(session.controlHolder).toBe("none");
    expect(session.waitingTakeover).toBe(true);
    expect(agentComputerUseAllowed(session)).toBe(false);
    expect(notifications.send).toHaveBeenCalledTimes(1);
    expect(notifications.send).toHaveBeenCalledWith(
      takeoverNotice({
        botName: "Finn",
        botId: "bot-1",
        threadId: "thr-1",
        reason: "preciso que você faça o login no banco",
      }),
      expect.objectContaining({ workspaceId: "ws-1", userId: "user-1", botId: "bot-1" }),
    );
  });

  it("refuses click and keystroke while waiting and after the owner takes the wheel, until release", async () => {
    const { session, run, notifications, prisma } = memoryComputer();
    await applyRequestTakeover({
      prisma,
      notifications,
      bot: { id: "bot-1", name: "Finn" },
      run,
      reason: "2FA",
    });

    expect(run.status).toBe("waiting_takeover");
    expect(agentComputerUseAllowed(session)).toBe(false);
    run.status = "running";
    await expect(
      lockComputerForAgent(prisma as never, {
        runId: run.id,
        workerId: "worker-1",
        runFence: 2,
        botId: "bot-1",
        now,
      }),
    ).resolves.toMatchObject({ ok: false, code: "takeover_active" });

    session.controlHolder = "user";
    expect(agentComputerUseAllowed(session)).toBe(false);
    await expect(
      lockComputerForAgent(prisma as never, {
        runId: run.id,
        workerId: "worker-1",
        runFence: 2,
        botId: "bot-1",
        now,
      }),
    ).resolves.toMatchObject({ ok: false, code: "takeover_active" });

    await clearWaitingTakeover(prisma, "bot-1");
    session.controlHolder = "bot";
    expect(session.waitingTakeover).toBe(false);
    expect(agentComputerUseAllowed(session)).toBe(true);
    await expect(
      lockComputerForAgent(prisma as never, {
        runId: run.id,
        workerId: "worker-1",
        runFence: 2,
        botId: "bot-1",
        now,
      }),
    ).resolves.toEqual({ ok: true, controlFence: 4 });
  });

  it("keeps the takeover notice in Portuguese", () => {
    const notice = takeoverNotice({
      botName: "Finn",
      botId: "bot-1",
      threadId: "thr-1",
      reason: "login",
    });
    expect(notice.kind).toBe("takeover");
    expect(notice.title).toBe("Finn precisa de você na tela");
    expect(notice.body).toBe("login");
  });
});
