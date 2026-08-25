import { call } from "@orpc/server";
import { SupervisorRequestError } from "@quibt/adapters";
import type { Actor } from "@quibt/contracts";
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

/** Um bot com a sessão "running" no banco e um provedor cujo `stop` faz o que o teste mandar. */
function harness(stop: () => Promise<void>) {
  const desktop = {
    botId: "bot-1",
    workspaceId: "ws-1",
    display: 1,
    providerRef: "container-1",
    screenUrl: "http://127.0.0.1:32801/embed.html",
    state: "running",
    controlHolder: "user",
    controlLeaseId: "lease-1" as string | null,
    controlLeaseUserId: "user-1" as string | null,
    controlLeaseExpiresAt: new Date(Date.now() + 60_000) as Date | null,
    controlFence: 1,
    computer: { id: "computer-1", kind: "docker", providerRef: "container-1" },
  };
  const bot = {
    id: "bot-1",
    workspaceId: "ws-1",
    name: "Chief",
    thread: null,
    desktopSession: desktop,
  };
  const stops: number[] = [];
  const prisma = {
    bot: { findFirst: async () => bot, findUnique: async () => bot },
    member: { findFirst: async () => ({ id: "m1", role: "owner" }) },
    agentHome: { findUnique: async () => null },
    computerUsage: { findMany: async () => [], update: async () => undefined },
    desktopSession: {
      findUnique: async () => desktop,
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
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
    wakeup: { enqueue: async () => undefined },
    sandbox: {
      stop: async () => {
        stops.push(Date.now());
        await stop();
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
  return { router: createRouter(deps), desktop, stops };
}

describe("computer.stop", () => {
  it("quando o provedor já não tem a sessão (404), marca desligado mesmo assim", async () => {
    // Depois de um reboot o container está parado e o supervisor responde 404 ao stop; a
    // rota lançava aqui e o banco seguia "running" — o botão "Desligar" não salvava nada.
    const { router, desktop, stops } = harness(async () => {
      throw new SupervisorRequestError("stop", 404, '{"error":"session not found"}');
    });

    const status = await call(
      router.computer.stop,
      { botId: "bot-1" },
      { context: { actor: owner } },
    );

    expect(stops).toHaveLength(1);
    expect(status.state).toBe("stopped");
    expect(desktop.state).toBe("stopped");
    expect(desktop.controlHolder).toBe("none");
    expect(desktop.controlLeaseId).toBeNull();
  });

  it("outra falha do provedor continua subindo, sem mexer no banco", async () => {
    const { router, desktop } = harness(async () => {
      throw new SupervisorRequestError("stop", 500, "boom");
    });

    await expect(
      call(router.computer.stop, { botId: "bot-1" }, { context: { actor: owner } }),
    ).rejects.toThrow();

    expect(desktop.state).toBe("running");
    expect(desktop.controlHolder).toBe("user");
  });

  it("com o provedor respondendo, desliga como sempre", async () => {
    const { router, desktop } = harness(async () => undefined);

    const status = await call(
      router.computer.stop,
      { botId: "bot-1" },
      { context: { actor: owner } },
    );

    expect(status.state).toBe("stopped");
    expect(desktop.state).toBe("stopped");
  });
});
