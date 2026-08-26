import { call, ORPCError } from "@orpc/server";
import type { Actor } from "@quibt/contracts";
import { CONTROL_LEASE_MS, CONTROL_LEASE_RENEW_GAP_MS } from "@quibt/core";
import type { PrismaClient } from "@quibt/db";
import { describe, expect, it } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

const owner: Actor = {
  userId: "user-1",
  workspaceId: "ws-1",
  workspaceRole: "owner",
  email: "owner@example.com",
  isDeploymentOwner: true,
};
const teammate: Actor = { ...owner, userId: "user-2", email: "mate@example.com" };

interface DesktopRow {
  botId: string;
  workspaceId: string;
  display: number;
  providerRef: string | null;
  screenUrl: string | null;
  state: string;
  controlHolder: string;
  controlLeaseId: string | null;
  controlLeaseUserId: string | null;
  controlLeaseExpiresAt: Date | null;
  controlLastInputAt: Date | null;
  controlFence: number;
  computer: { id: string; kind: string; providerRef: string | null };
}

function harness(overrides: Partial<DesktopRow> = {}) {
  const desktop: DesktopRow = {
    botId: "bot-1",
    workspaceId: "ws-1",
    display: 1,
    providerRef: "container-1",
    screenUrl: null,
    state: "running",
    controlHolder: "bot",
    controlLeaseId: null,
    controlLeaseUserId: null,
    controlLeaseExpiresAt: null,
    controlLastInputAt: null,
    controlFence: 0,
    computer: { id: "computer-1", kind: "docker", providerRef: "container-1" },
    ...overrides,
  };
  const inputs: Array<{ leaseId: string; fence: number }> = [];
  const jobs: Array<{ name: string; payload: unknown; runAt?: Date }> = [];
  const keepAlives: Array<{ botId: string; workspaceId?: string }> = [];
  const bot = {
    id: "bot-1",
    workspaceId: "ws-1",
    name: "Chief",
    thread: null,
    desktopSession: desktop,
  };
  const prisma = {
    bot: { findFirst: async () => bot, findUnique: async () => bot },
    member: { findFirst: async () => ({ id: "m1", role: "owner" }) },
    agentHome: { findUnique: async () => null },
    run: { findFirst: async () => null },
    orphanProvision: { updateMany: async () => ({ count: 0 }) },
    desktopSession: {
      findUnique: async () => desktop,
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (where.controlFence !== undefined && where.controlFence !== desktop.controlFence) {
          return { count: 0 };
        }
        if (where.controlHolder && where.controlHolder !== desktop.controlHolder) {
          return { count: 0 };
        }
        if (where.controlLeaseId !== undefined && where.controlLeaseId !== desktop.controlLeaseId) {
          return { count: 0 };
        }
        if (
          where.controlLeaseUserId !== undefined &&
          where.controlLeaseUserId !== desktop.controlLeaseUserId
        ) {
          return { count: 0 };
        }
        Object.assign(desktop, data);
        return { count: 1 };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(desktop, data);
        return desktop;
      },
    },
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    wakeup: {
      enqueue: async (job: { name: string; payload: unknown; runAt?: Date }) => {
        jobs.push(job);
      },
    },
    sandbox: {
      sendInput: async (
        _computer: unknown,
        _mapped: unknown,
        lease: { leaseId: string; fence: number },
      ) => {
        inputs.push({ leaseId: lease.leaseId, fence: lease.fence });
      },
      keepAlive: async (computer: { botId: string }, context?: { workspaceId?: string }) => {
        keepAlives.push({ botId: computer.botId, workspaceId: context?.workspaceId });
      },
    },
    env: {
      defaultProvider: "openrouter",
      defaultModel: "model",
      screenProxySecret: "secret",
      sandboxProvider: "docker",
      webOrigin: "https://app.example",
    },
  } as unknown as RouterDeps;
  return { router: createRouter(deps), desktop, inputs, jobs, keepAlives };
}

const keypress = { botId: "bot-1", kind: "key" as const, payload: { key: "a" } };

describe("computer.takeover", () => {
  it("issues an unguessable lease, persists its deadline, and moves the fence", async () => {
    const { router, desktop, jobs, keepAlives } = harness();
    const granted = await call(
      router.computer.takeover,
      { botId: "bot-1" },
      { context: { actor: owner } },
    );
    expect(granted.leaseId).not.toBe("lease-bot-1");
    expect(desktop.controlLeaseId).toBe(granted.leaseId);
    expect(desktop.controlLeaseUserId).toBe("user-1");
    expect(desktop.controlFence).toBe(1);
    expect(desktop.controlLeaseExpiresAt?.toISOString()).toBe(granted.expiresAt);
    // Something has to end the lease if the person walks away.
    expect(jobs.map((job) => job.name)).toContain("control.reap");
    const reap = jobs.find((job) => job.name === "control.reap");
    expect(reap?.runAt?.toISOString()).toBe(granted.expiresAt);
    expect(keepAlives).toEqual([{ botId: "bot-1", workspaceId: "ws-1" }]);
  });

  it("refuses a second member while the first one still holds the keyboard", async () => {
    const { router } = harness();
    await call(router.computer.takeover, { botId: "bot-1" }, { context: { actor: owner } });
    await expect(
      call(router.computer.takeover, { botId: "bot-1" }, { context: { actor: teammate } }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it("lets anyone take over once the lease has run out", async () => {
    const { router, desktop } = harness({
      controlHolder: "user",
      controlLeaseId: "ctl_old",
      controlLeaseUserId: "user-1",
      controlLeaseExpiresAt: new Date(Date.now() - 1_000),
      controlFence: 4,
    });
    const granted = await call(
      router.computer.takeover,
      { botId: "bot-1" },
      { context: { actor: teammate } },
    );
    expect(desktop.controlLeaseUserId).toBe("user-2");
    expect(desktop.controlFence).toBe(5);
    expect(granted.leaseId).not.toBe("ctl_old");
  });
});

describe("computer.input", () => {
  it("passes the live lease and its fence to the sandbox", async () => {
    const { router, inputs } = harness();
    const granted = await call(
      router.computer.takeover,
      { botId: "bot-1" },
      { context: { actor: owner } },
    );
    await call(
      router.computer.input,
      { ...keypress, leaseId: granted.leaseId },
      { context: { actor: owner } },
    );
    expect(inputs).toEqual([{ leaseId: granted.leaseId, fence: 1 }]);
  });

  it("refuses a stale lease id even from the holder", async () => {
    const { router, inputs } = harness();
    await call(router.computer.takeover, { botId: "bot-1" }, { context: { actor: owner } });
    await expect(
      call(
        router.computer.input,
        { ...keypress, leaseId: "ctl_stale" },
        { context: { actor: owner } },
      ),
    ).rejects.toThrow(/não vale mais/);
    expect(inputs).toEqual([]);
  });

  it("refuses another member who never took control", async () => {
    const { router, inputs } = harness();
    await call(router.computer.takeover, { botId: "bot-1" }, { context: { actor: owner } });
    await expect(
      call(router.computer.input, keypress, { context: { actor: teammate } }),
    ).rejects.toThrow(/Outra pessoa/);
    expect(inputs).toEqual([]);
  });

  it("refuses an expired lease and hands the computer back to the bot", async () => {
    const { router, desktop, inputs } = harness({
      controlHolder: "user",
      controlLeaseId: "ctl_old",
      controlLeaseUserId: "user-1",
      controlLeaseExpiresAt: new Date(Date.now() - 1_000),
      controlFence: 2,
    });
    await expect(
      call(router.computer.input, keypress, { context: { actor: owner } }),
    ).rejects.toThrow(/expirou/);
    expect(inputs).toEqual([]);
    expect(desktop.controlHolder).toBe("bot");
    expect(desktop.controlLeaseId).toBeNull();
  });
});

/**
 * Um lease do dono com parte do prazo já consumida — o caso de quem está usando há um tempo.
 * `typed` diz se houve tecla depois da última renovação: é isso, e não o heartbeat, que
 * autoriza outra janela.
 */
function usedLease(consumedMs: number, typed = false) {
  const grantedAt = Date.now() - consumedMs;
  return {
    controlHolder: "user",
    controlLeaseId: "ctl_live",
    controlLeaseUserId: "user-1",
    controlLeaseExpiresAt: new Date(grantedAt + CONTROL_LEASE_MS),
    controlLastInputAt: typed ? new Date(grantedAt + Math.floor(consumedMs / 2)) : null,
    controlFence: 2,
  };
}

describe("computer.heartbeat", () => {
  it("renova o prazo de quem esteve teclando e reagenda o reap, sem mexer no fence nem no id", async () => {
    const { router, desktop, jobs, keepAlives } = harness(
      usedLease(2 * CONTROL_LEASE_RENEW_GAP_MS, true),
    );
    const before = desktop.controlLeaseExpiresAt?.getTime() ?? 0;
    const answer = await call(
      router.computer.heartbeat,
      { botId: "bot-1" },
      { context: { actor: owner } },
    );
    const after = desktop.controlLeaseExpiresAt?.getTime() ?? 0;
    // A tela precisa do prazo novo para escrever "controle até HH:mm" sem ficar parada no
    // horário do takeover.
    expect(answer.controlLeaseExpiresAt).toBe(desktop.controlLeaseExpiresAt?.toISOString());
    expect(after).toBeGreaterThan(before);
    expect(after).toBeGreaterThanOrEqual(Date.now() + CONTROL_LEASE_MS - 1_000);
    expect(desktop.controlLeaseId).toBe("ctl_live");
    expect(desktop.controlFence).toBe(2);
    const reap = jobs.find((job) => job.name === "control.reap");
    expect(reap?.runAt?.getTime()).toBe(after);
    // E continua acordando o container, como antes.
    expect(keepAlives).toEqual([{ botId: "bot-1", workspaceId: "ws-1" }]);
  });

  it("não renova a cada batida: um lease recém-concedido fica como está", async () => {
    const { router, desktop, jobs } = harness(usedLease(0, true));
    const before = desktop.controlLeaseExpiresAt;
    const answer = await call(
      router.computer.heartbeat,
      { botId: "bot-1" },
      { context: { actor: owner } },
    );
    expect(desktop.controlLeaseExpiresAt).toEqual(before);
    expect(answer.controlLeaseExpiresAt).toBeNull();
    expect(jobs.map((job) => job.name)).not.toContain("control.reap");
  });

  it("uma tela deixada aberta não segura o teclado: sem tecla, o heartbeat só acorda o container", async () => {
    const { router, desktop, jobs, keepAlives } = harness(
      usedLease(2 * CONTROL_LEASE_RENEW_GAP_MS),
    );
    const before = desktop.controlLeaseExpiresAt;
    // Meia hora de aba aberta batendo de minuto em minuto, ninguém na frente.
    for (let beat = 0; beat < 30; beat += 1) {
      const answer = await call(
        router.computer.heartbeat,
        { botId: "bot-1" },
        { context: { actor: owner } },
      );
      expect(answer.controlLeaseExpiresAt).toBeNull();
    }
    expect(desktop.controlLeaseExpiresAt).toEqual(before);
    expect(jobs.map((job) => job.name)).not.toContain("control.reap");
    // O container continua acordado — é para isso que o heartbeat existe.
    expect(keepAlives.length).toBe(30);
  });

  it("o heartbeat de quem não é o dono não estica o lease de ninguém", async () => {
    const { router, desktop, jobs } = harness(usedLease(2 * CONTROL_LEASE_RENEW_GAP_MS));
    const before = desktop.controlLeaseExpiresAt;
    await call(router.computer.heartbeat, { botId: "bot-1" }, { context: { actor: teammate } });
    expect(desktop.controlLeaseExpiresAt).toEqual(before);
    expect(desktop.controlLeaseUserId).toBe("user-1");
    expect(jobs.map((job) => job.name)).not.toContain("control.reap");
  });
});

describe("computer.input renova pelo uso", () => {
  it("cada tecla depois da folga empurra o prazo e a tecla chega mesmo assim", async () => {
    const { router, desktop, inputs, jobs } = harness(usedLease(2 * CONTROL_LEASE_RENEW_GAP_MS));
    const before = desktop.controlLeaseExpiresAt?.getTime() ?? 0;
    await call(
      router.computer.input,
      { ...keypress, leaseId: "ctl_live" },
      { context: { actor: owner } },
    );
    expect(inputs).toEqual([{ leaseId: "ctl_live", fence: 2 }]);
    expect(desktop.controlLeaseExpiresAt?.getTime() ?? 0).toBeGreaterThan(before);
    expect(jobs.find((job) => job.name === "control.reap")?.runAt).toEqual(
      desktop.controlLeaseExpiresAt,
    );
  });

  it("quem está com o teclado dentro da tela (noVNC) renova pelo heartbeat", async () => {
    // Esse caminho não passa por computer.input: as teclas vão direto pelo WebSocket.
    const { router, desktop } = harness(usedLease(2 * CONTROL_LEASE_RENEW_GAP_MS));
    const before = desktop.controlLeaseExpiresAt?.getTime() ?? 0;
    const answer = await call(
      router.computer.heartbeat,
      { botId: "bot-1", atScreen: true },
      { context: { actor: owner } },
    );
    expect(desktop.controlLeaseExpiresAt?.getTime() ?? 0).toBeGreaterThan(before);
    expect(answer.controlLeaseExpiresAt).toBe(desktop.controlLeaseExpiresAt?.toISOString());
  });

  it("a tecla dentro da folga fica registrada e é ela que libera o heartbeat seguinte", async () => {
    const { router, desktop, jobs } = harness(usedLease(1_000));
    const before = desktop.controlLeaseExpiresAt;
    const typed = await call(
      router.computer.input,
      { ...keypress, leaseId: "ctl_live" },
      { context: { actor: owner } },
    );
    // Cedo demais para renovar, mas o uso ficou anotado.
    expect(typed.controlLeaseExpiresAt).toBeNull();
    expect(desktop.controlLeaseExpiresAt).toEqual(before);
    expect(desktop.controlLastInputAt).toBeInstanceOf(Date);
    // Agora sim: o prazo já consumiu a folga e houve tecla desde a última renovação.
    desktop.controlLeaseExpiresAt = new Date(
      Date.now() + CONTROL_LEASE_MS - 2 * CONTROL_LEASE_RENEW_GAP_MS,
    );
    const beat = await call(
      router.computer.heartbeat,
      { botId: "bot-1" },
      { context: { actor: owner } },
    );
    expect(beat.controlLeaseExpiresAt).toBe(desktop.controlLeaseExpiresAt?.toISOString());
    expect(jobs.map((job) => job.name)).toContain("control.reap");
  });
});

describe("computer.status", () => {
  it("does not expose a raw VNC capability before the actor holds the control lease", async () => {
    const { router } = harness({
      screenUrl: "http://127.0.0.1:49152/embed.html",
    });

    const watching = await call(
      router.computer.status,
      { botId: "bot-1" },
      { context: { actor: owner } },
    );
    expect(watching.screenUrl).toBeNull();

    await call(router.computer.takeover, { botId: "bot-1" }, { context: { actor: owner } });
    const controlling = await call(
      router.computer.status,
      { botId: "bot-1" },
      { context: { actor: owner } },
    );
    expect(controlling.screenUrl).toContain(".control/");
    expect(controlling.screenUrl).toContain("view_only=false");
  });

  it("refuses the dedicated screenUrl RPC until this actor holds the lease", async () => {
    const { router } = harness({
      screenUrl: "http://127.0.0.1:49152/embed.html",
    });

    await expect(
      call(router.computer.screenUrl, { botId: "bot-1" }, { context: { actor: owner } }),
    ).resolves.toEqual({ url: null });

    await call(router.computer.takeover, { botId: "bot-1" }, { context: { actor: owner } });
    const driving = await call(
      router.computer.screenUrl,
      { botId: "bot-1" },
      { context: { actor: owner } },
    );
    expect(driving.url).toContain(".control/");
    expect(driving.url).toContain("view_only=false");
  });

  it("stops reporting a lease that already expired", async () => {
    const { router, desktop } = harness({
      controlHolder: "user",
      controlLeaseId: "ctl_old",
      controlLeaseUserId: "user-1",
      controlLeaseExpiresAt: new Date(Date.now() - 1_000),
      controlFence: 2,
    });
    const status = await call(
      router.computer.status,
      { botId: "bot-1" },
      { context: { actor: owner } },
    );
    expect(status.controlHolder).toBe("bot");
    expect(status.controlLeaseExpiresAt).toBeNull();
    expect(desktop.controlHolder).toBe("bot");
  });

  it("reports the deadline while the lease is live", async () => {
    const { router } = harness();
    const granted = await call(
      router.computer.takeover,
      { botId: "bot-1" },
      { context: { actor: owner } },
    );
    const status = await call(
      router.computer.status,
      { botId: "bot-1" },
      { context: { actor: owner } },
    );
    expect(status.controlHolder).toBe("user");
    expect(status.controlLeaseExpiresAt).toBe(granted.expiresAt);
  });
});

describe("computer.release", () => {
  it("refuses to release someone else's control and clears the holder's own", async () => {
    const { router, desktop } = harness();
    await call(router.computer.takeover, { botId: "bot-1" }, { context: { actor: owner } });
    await expect(
      call(router.computer.release, { botId: "bot-1" }, { context: { actor: teammate } }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(desktop.controlHolder).toBe("user");
    await call(router.computer.release, { botId: "bot-1" }, { context: { actor: owner } });
    expect(desktop.controlHolder).toBe("bot");
    expect(desktop.controlLeaseUserId).toBeNull();
  });
});
