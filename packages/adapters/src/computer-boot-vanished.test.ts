import type { AdapterContext, SandboxProvider } from "@quibt/adapter-kit";
import type { PrismaClient } from "@quibt/db";
import { describe, expect, it, vi } from "vitest";
import { bootComputer, forgetVanishedWorkspaceComputer } from "./computer-boot.js";

const context: AdapterContext & { userId: string } = {
  operationId: "boot",
  traceId: "boot",
  workspaceId: "ws-1",
  userId: "user-1",
  botId: "bot-b",
  signal: new AbortController().signal,
};

/**
 * Uma sessão que o banco diz "running", num computador de workspace cujo container o
 * provedor pode ou não ter ainda. `computer.upsert` é o primeiro passo do caminho normal de
 * boot: chegar nele prova que o atalho "já está rodando" foi abandonado.
 */
function harness(exists: boolean | undefined) {
  const session = {
    botId: "bot-b",
    workspaceId: "ws-1",
    computerId: "comp-1",
    display: 2,
    providerRef: null as string | null,
    screenUrl: "http://127.0.0.1:6081/embed.html" as string | null,
    state: "running",
    controlHolder: "user",
    controlLeaseId: "lease-1" as string | null,
    bootClaimToken: null as string | null,
    bootClaimedAt: null as Date | null,
    computer: {
      id: "comp-1",
      kind: "docker",
      providerRef: "container-workspace",
      state: "running",
      bootClaimToken: null as string | null,
    },
  };
  const sandbox = {
    connectScreen: vi.fn(async () => ({
      url: "http://127.0.0.1:6081/embed.html",
      mimeType: "text/html",
      close: async () => undefined,
    })),
    ...(exists === undefined ? {} : { exists: vi.fn(async () => exists) }),
  } as unknown as SandboxProvider;
  const prisma = {
    desktopSession: {
      findUnique: vi.fn(async () => session),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(session, data);
        return { count: 1 };
      }),
    },
    computer: {
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(session.computer, data);
        return { count: 1 };
      }),
      upsert: vi.fn(async () => {
        throw new Error("BOOT-PATH");
      }),
    },
  } as unknown as PrismaClient;
  return {
    deps: {
      prisma,
      sandbox,
      home: { resolve: () => "/tmp/home" } as never,
      dataDir: "/tmp/data",
    },
    session,
    prisma,
    sandbox,
  };
}

describe("booting a bot whose workspace container vanished under the database", () => {
  it("forgets the running rows and goes down the normal boot path", async () => {
    // O caso real: o app atualizou a imagem, o supervisor recriou o container (ou o Docker
    // reiniciou) — e cada comando do bot voltava "computer not found" até o sono por
    // ociosidade limpar a linha, minutos depois.
    const { deps, session, prisma } = harness(false);

    await expect(bootComputer(deps, "bot-b", context)).rejects.toThrow("BOOT-PATH");

    expect(session.state).toBe("stopped");
    expect(session.screenUrl).toBeNull();
    expect(session.controlHolder).toBe("none");
    expect(session.controlLeaseId).toBeNull();
    expect(session.computer.state).toBe("stopped");
    expect(prisma.desktopSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { computerId: "comp-1", state: "running", bootClaimToken: null },
      }),
    );
  });

  it("keeps the fast path when the provider still has the container", async () => {
    const { deps, session, prisma } = harness(true);

    const ref = await bootComputer(deps, "bot-b", context);

    expect(ref.screenUrl).toBe("http://127.0.0.1:6081/embed.html");
    expect(session.state).toBe("running");
    expect(prisma.computer.upsert).not.toHaveBeenCalled();
  });

  it("trusts the database when the provider cannot say (no exists())", async () => {
    const { deps, session } = harness(undefined);

    const ref = await bootComputer(deps, "bot-b", context);

    expect(ref.screenUrl).toBe("http://127.0.0.1:6081/embed.html");
    expect(session.state).toBe("running");
  });

  it("never touches a row with a claim in flight", async () => {
    const { prisma } = harness(false);

    await forgetVanishedWorkspaceComputer(prisma, "comp-1");

    expect(prisma.computer.updateMany).toHaveBeenCalledWith({
      where: { id: "comp-1", state: "running", bootClaimToken: null },
      data: { state: "stopped" },
    });
  });
});

describe("ensureWorkspaceComputer when the provider no longer has the container", () => {
  it("forgets the running row and goes on to provision instead of handing back a ghost", async () => {
    // Uma sessão suspensa que acordava achava o computador "running" no banco, ganhava a
    // referência morta e cada comando voltava "computer not found".
    const { ensureWorkspaceComputer } = await import("./computer-boot.js");
    const computer = {
      id: "comp-1",
      workspaceId: "ws-1",
      userId: "user-1",
      kind: "docker",
      state: "running",
      providerRef: "container-gone",
      bootClaimToken: null as string | null,
    };
    const updates: Array<Record<string, unknown>> = [];
    const prisma = {
      computer: {
        upsert: vi.fn(async () => computer),
        findUnique: vi.fn(async () => computer),
        updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          if (data.state === "stopped") {
            computer.state = "stopped";
            return { count: 1 };
          }
          throw new Error("PROVISION-PATH");
        }),
      },
      desktopSession: { updateMany: vi.fn(async () => ({ count: 0 })) },
    } as unknown as PrismaClient;
    const sandbox = {
      exists: vi.fn(async () => false),
    } as unknown as SandboxProvider;

    await expect(
      ensureWorkspaceComputer(
        { prisma, sandbox, home: { resolve: () => "/tmp/home" } as never, dataDir: "/tmp/data" },
        "ws-1",
        "user-1",
        context,
        { kind: "docker" },
      ),
    ).rejects.toThrow(/PROVISION-PATH|gate/);

    expect(updates[0]).toEqual({ state: "stopped" });
    expect(sandbox.exists).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "container-gone" }),
      expect.anything(),
    );
  });
});
