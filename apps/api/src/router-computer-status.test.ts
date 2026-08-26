import { call } from "@orpc/server";
import { type Actor, ComputerStatusSchema } from "@quibt/contracts";
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

function harness(state: string) {
  const desktop = {
    botId: "bot-1",
    workspaceId: "ws-1",
    display: 1,
    providerRef: "container-1",
    screenUrl: "http://127.0.0.1:32801/embed.html",
    state,
    controlHolder: "none",
    controlLeaseId: null,
    controlLeaseUserId: null,
    controlLeaseExpiresAt: null,
    controlFence: 1,
    computer: { id: "computer-1", kind: "docker", providerRef: "container-1" },
  };
  const bot = {
    id: "bot-1",
    workspaceId: "ws-1",
    name: "Finn",
    thread: null,
    desktopSession: desktop,
  };
  const prisma = {
    bot: { findFirst: async () => bot, findUnique: async () => bot },
    member: { findFirst: async () => ({ id: "member-1", role: "owner" }) },
    agentHome: { findUnique: async () => null },
    desktopSession: {
      findUnique: async () => desktop,
      updateMany: async () => ({ count: 0 }),
    },
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    env: {
      defaultProvider: "openrouter",
      defaultModel: "model",
      screenProxySecret: "secret",
      sandboxProvider: "docker",
      webOrigin: "https://app.example",
    },
  } as unknown as RouterDeps;
  return createRouter(deps);
}

describe("computer.status durante transicoes internas", () => {
  it.each([
    ["suspending", "suspended"],
    ["deleting", "stopped"],
  ])("converte %s em %s e continua respeitando o contrato", async (stored, exposed) => {
    const router = harness(stored);

    const status = await call(
      router.computer.status,
      { botId: "bot-1" },
      { context: { actor: owner } },
    );

    expect(status.state).toBe(exposed);
    expect(ComputerStatusSchema.safeParse(status).success).toBe(true);
  });

  it("nao deixa um valor antigo ou corrompido derrubar a conversa inteira", async () => {
    const router = harness("legacy-transition");

    const status = await call(
      router.computer.status,
      { botId: "bot-1" },
      { context: { actor: owner } },
    );

    expect(status.state).toBe("error");
    expect(ComputerStatusSchema.safeParse(status).success).toBe(true);
  });
});
