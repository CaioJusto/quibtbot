import type { AdapterContext, SandboxProvider } from "@quibt/adapter-kit";
import type { PrismaClient } from "@quibt/db";
import { describe, expect, it, vi } from "vitest";
import { bootComputer } from "./computer-boot.js";

const context: AdapterContext & { userId: string } = {
  operationId: "boot",
  traceId: "boot",
  workspaceId: "ws-1",
  userId: "user-1",
  botId: "bot-b",
  signal: new AbortController().signal,
};

/** A session that is already up, but has no screen address written down. */
function makeRunningHarness(connectScreen: SandboxProvider["connectScreen"]) {
  const session = {
    botId: "bot-b",
    workspaceId: "ws-1",
    computerId: "comp-1",
    display: 2,
    providerRef: "container-workspace" as string | null,
    screenUrl: null as string | null,
    state: "running",
    controlHolder: "user",
    bootClaimToken: null as string | null,
    bootClaimedAt: null as Date | null,
    computer: {
      id: "comp-1",
      kind: "docker",
      providerRef: "container-workspace",
      state: "running",
    },
  };
  const sandbox = { connectScreen } as unknown as SandboxProvider;
  const prisma = {
    desktopSession: {
      findUnique: vi.fn(async () => session),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(session, data);
        return { count: 1 };
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
  };
}

describe("booting a computer that is already running", () => {
  it("asks the provider where the screen is when the session has no URL, and records it", async () => {
    // Taking control puts the row in `running` on its own, so a boot that finds it running
    // used to return with no screen address at all — the app then showed a placeholder to
    // someone who was holding the keyboard.
    const connectScreen = vi.fn(async () => ({
      url: "http://127.0.0.1:35590/embed.html",
      mimeType: "text/html",
      close: async () => undefined,
    })) as unknown as SandboxProvider["connectScreen"];
    const { deps, session } = makeRunningHarness(connectScreen);

    const ref = await bootComputer(deps, "bot-b", context);

    expect(ref.screenUrl).toBe("http://127.0.0.1:35590/embed.html");
    expect(session.screenUrl).toBe("http://127.0.0.1:35590/embed.html");
    expect(connectScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "container-workspace", display: 2 }),
      { view: "stream" },
      expect.objectContaining({ botId: "bot-b" }),
    );
  });

  it("corrige um endereço velho: a porta do noVNC muda quando o display muda", async () => {
    // O caso real: o bot tinha a porta do display 1 escrita, mas passou a servir no
    // display 2 depois de a sessão morrer e voltar. Com o endereço antigo, a tela
    // abria preta e ficava piscando — mesmo com o controle na mão.
    const connectScreen = vi.fn(async () => ({
      url: "http://127.0.0.1:6081/embed.html",
      mimeType: "text/html",
      close: async () => undefined,
    })) as unknown as SandboxProvider["connectScreen"];
    const { deps, session } = makeRunningHarness(connectScreen);
    session.screenUrl = "http://127.0.0.1:6080/embed.html";

    const ref = await bootComputer(deps, "bot-b", context);

    expect(ref.screenUrl).toBe("http://127.0.0.1:6081/embed.html");
    expect(session.screenUrl).toBe("http://127.0.0.1:6081/embed.html");
    expect(connectScreen).toHaveBeenCalledTimes(1);
  });

  it("mantém o endereço quando o provedor confirma o mesmo, sem escrever à toa", async () => {
    const connectScreen = vi.fn(async () => ({
      url: "http://127.0.0.1:35590/embed.html",
      mimeType: "text/html",
      close: async () => undefined,
    })) as unknown as SandboxProvider["connectScreen"];
    const { deps, session, prisma } = makeRunningHarness(connectScreen);
    session.screenUrl = "http://127.0.0.1:35590/embed.html";

    const ref = await bootComputer(deps, "bot-b", context);

    expect(ref.screenUrl).toBe("http://127.0.0.1:35590/embed.html");
    expect(prisma.desktopSession.updateMany).not.toHaveBeenCalled();
  });

  it("segura o endereço conhecido quando o provedor não responde na hora de abrir", async () => {
    const connectScreen = vi.fn(async () => {
      throw new Error("supervisor down");
    }) as unknown as SandboxProvider["connectScreen"];
    const { deps, session } = makeRunningHarness(connectScreen);
    session.screenUrl = "http://127.0.0.1:35590/embed.html";

    const ref = await bootComputer(deps, "bot-b", context);

    // Melhor tentar o último endereço conhecido do que abrir sem nenhum.
    expect(ref.screenUrl).toBe("http://127.0.0.1:35590/embed.html");
  });

  it("still boots when the provider cannot say where the screen is", async () => {
    const connectScreen = vi.fn(async () => {
      throw new Error("supervisor down");
    }) as unknown as SandboxProvider["connectScreen"];
    const { deps, session } = makeRunningHarness(connectScreen);

    const ref = await bootComputer(deps, "bot-b", context);

    expect(ref.screenUrl).toBeUndefined();
    expect(session.screenUrl).toBeNull();
  });
});
