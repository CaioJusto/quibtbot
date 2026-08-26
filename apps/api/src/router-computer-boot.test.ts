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

/**
 * Bot com a linha "running" no banco e um provedor cujo `exists` faz o que o teste mandar.
 * O atalho de `computer.boot` — "a linha diz running, devolve o status e pronto" — é o
 * único caminho exercitado aqui.
 */
function harness(exists: () => Promise<boolean>) {
  const desktop = {
    botId: "bot-1",
    workspaceId: "ws-1",
    display: 1,
    providerRef: "container-1",
    screenUrl: "http://127.0.0.1:32801/embed.html?password=velha",
    state: "running",
    controlHolder: "none",
    controlLeaseId: null as string | null,
    controlLeaseUserId: null as string | null,
    controlLeaseExpiresAt: null as Date | null,
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
    sandbox: { exists },
    env: {
      defaultProvider: "openrouter",
      defaultModel: "model",
      screenProxySecret: "secret",
      sandboxProvider: "docker",
      webOrigin: "https://app.example",
    },
  } as unknown as RouterDeps;
  return { router: createRouter(deps), desktop };
}

describe("computer.boot com o supervisor fora do ar", () => {
  it("diz para abrir o Docker em vez de responder 'ligado' com a tela morta", async () => {
    // O supervisor roda dentro do Docker nas três topologias do produto: com o Docker
    // fechado ninguém atende a porta. Confiar na linha do banco aqui entregava a
    // screenUrl de antes — porta e senha que já não existem — e um retângulo preto.
    const { router, desktop } = harness(async () => {
      throw new SupervisorRequestError(
        "exists",
        503,
        JSON.stringify({
          error: "O computador não respondeu: o Docker (ou o Quibt) não está rodando.",
          code: "docker-down",
        }),
      );
    });

    const failure = await call(
      router.computer.boot,
      { botId: "bot-1" },
      { context: { actor: owner } },
    ).catch((error: unknown) => error);

    expect((failure as Error).message).toMatch(/Docker/);
    expect((failure as Error).message).not.toMatch(/fetch failed/);
    // A linha continua verdadeira: o container existe, só não dá para falar com ele agora.
    expect(desktop.state).toBe("running");
  });

  it("uma falha que não é do supervisor continua confiando na linha", async () => {
    // Um provedor que respondeu qualquer outra coisa não prova que o computador morreu;
    // derrubar a sessão por causa disso era o comportamento antigo, pior.
    const { router } = harness(async () => {
      throw new Error("boom");
    });

    const status = await call(
      router.computer.boot,
      { botId: "bot-1" },
      { context: { actor: owner } },
    );

    expect(status.state).toBe("running");
  });

  it("com o supervisor respondendo, o atalho segue igual", async () => {
    const { router } = harness(async () => true);

    const status = await call(
      router.computer.boot,
      { botId: "bot-1" },
      { context: { actor: owner } },
    );

    expect(status.state).toBe("running");
  });
});
