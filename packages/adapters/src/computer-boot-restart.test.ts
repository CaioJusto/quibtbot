import type {
  AdapterContext,
  ComputerRef,
  ProcessEvent,
  SandboxProvider,
} from "@quibt/adapter-kit";
import type { PrismaClient } from "@quibt/db";
import { describe, expect, it, vi } from "vitest";
import { bootComputer, ensureWorkspaceComputer } from "./computer-boot.js";
import { publicComputerBootMessage, SupervisorRequestError } from "./docker-sandbox.js";

const context: AdapterContext & { userId: string } = {
  operationId: "boot",
  traceId: "boot",
  workspaceId: "ws-1",
  userId: "user-1",
  botId: "bot-b",
  signal: new AbortController().signal,
};

const OLD_SCREEN = "http://127.0.0.1:32801/embed.html?password=old";
const NEW_SCREEN = "http://127.0.0.1:32901/embed.html?password=new";

type StartOutcome = "ok" | "route-missing" | "docker-down" | "other-id";

/**
 * Um container de workspace `Exited` — o Mac reiniciou antes de o container ter política
 * de reinício, ou alguém deu `docker stop` — com a linha do banco ainda "running". O
 * provedor de mentira faz o que o supervisor faz: `/exists` diz `running:false`, `/start`
 * liga o mesmo container, a tela reabre num endereço novo e o exec volta a funcionar.
 * `computer.upsert` é o primeiro passo do caminho normal de boot: chegar nele prova que o
 * atalho "já está ligado" foi abandonado e o computador seria provisionado de novo.
 */
function harness(start: StartOutcome = "ok") {
  const container = { id: "container-workspace", running: false };
  const session = {
    botId: "bot-b",
    workspaceId: "ws-1",
    computerId: "comp-1",
    display: 2,
    providerRef: null as string | null,
    screenUrl: OLD_SCREEN as string | null,
    state: "running",
    controlHolder: "user",
    controlLeaseId: "lease-1" as string | null,
    bootClaimToken: null as string | null,
    bootClaimedAt: null as Date | null,
    computer: {
      id: "comp-1",
      kind: "docker",
      providerRef: container.id,
      state: "running",
      bootClaimToken: null as string | null,
    },
  };
  const sandbox = {
    presence: vi.fn(async () => (container.running ? "running" : "stopped")),
    start: vi.fn(async (ref: ComputerRef) => {
      if (start === "route-missing") {
        throw new SupervisorRequestError("start", 404, '{"error":"computer not found"}');
      }
      if (start === "docker-down") {
        throw new SupervisorRequestError(
          "start",
          503,
          JSON.stringify({
            error:
              "O computador estava desligado e não conseguiu religar: abra o Docker e tente de novo.",
            code: "docker-down",
          }),
        );
      }
      container.running = true;
      const id = start === "other-id" ? "container-recreated" : ref.id;
      return { ...ref, id, providerRef: id };
    }),
    connectScreen: vi.fn(async () => ({
      url: container.running ? NEW_SCREEN : null,
      mimeType: "text/html",
      close: async () => undefined,
    })),
    async *execute(): AsyncIterable<ProcessEvent> {
      if (!container.running) {
        yield { type: "stderr", data: "computer request failed" };
        yield { type: "exit", code: 1 };
        return;
      }
      yield { type: "stdout", data: "ok\n" };
      yield { type: "exit", code: 0 };
    },
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
    container,
  };
}

async function runCommand(sandbox: SandboxProvider, ref: ComputerRef) {
  const events: ProcessEvent[] = [];
  for await (const event of sandbox.execute(ref, { argv: ["true"] }, context)) events.push(event);
  return events;
}

describe("container Exited após um reboot", () => {
  it("o boot religa no lugar e o comando seguinte funciona", async () => {
    const { deps, session, prisma, sandbox, container } = harness();

    const ref = await bootComputer(deps, "bot-b", context);

    expect(sandbox.start).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "container-workspace" }),
      expect.objectContaining({ workspaceId: "ws-1", botId: "bot-b" }),
    );
    expect(container.running).toBe(true);
    // Religar não é provisionar do zero nem esquecer a sessão: a linha segue "running"
    // (nunca passou por "stopped"), só a tela ganhou o endereço novo.
    expect(prisma.computer.upsert).not.toHaveBeenCalled();
    expect(session.state).toBe("running");
    expect(session.computer.state).toBe("running");
    expect(prisma.desktopSession.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: "stopped" }) }),
    );
    expect(ref.screenUrl).toBe(NEW_SCREEN);
    expect(session.screenUrl).toBe(NEW_SCREEN);
    expect(await runCommand(sandbox, ref)).toEqual([
      { type: "stdout", data: "ok\n" },
      { type: "exit", code: 0 },
    ]);
  });

  it("não religa nada quando o provedor diz que está ligado", async () => {
    const { deps, sandbox, container } = harness();
    container.running = true;

    const ref = await bootComputer(deps, "bot-b", context);

    expect(sandbox.start).not.toHaveBeenCalled();
    expect(ref.screenUrl).toBe(NEW_SCREEN);
  });

  it("supervisor antigo sem a rota de religar: cai no caminho normal, que retoma o container", async () => {
    // Uma VPS que ainda não atualizou responde 404 ao `/start`. Não é erro para a pessoa:
    // o provision do supervisor também dá `start` num container que já existe.
    const { deps, session, sandbox } = harness("route-missing");

    await expect(bootComputer(deps, "bot-b", context)).rejects.toThrow("BOOT-PATH");

    expect(sandbox.start).toHaveBeenCalledTimes(1);
    expect(session.state).toBe("stopped");
    expect(session.computer.state).toBe("stopped");
  });

  it("Docker fechado: o boot falha dizendo para abrir o Docker e não esquece a sessão", async () => {
    // Provisionar de novo esbarraria na mesma parede; e a linha continua verdadeira: o
    // container existe, só não dá para ligá-lo agora.
    const { deps, session, prisma } = harness("docker-down");

    const failure = await bootComputer(deps, "bot-b", context).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/abra o Docker/);
    expect(publicComputerBootMessage(failure)).toMatch(/estava desligado.*abra o Docker/);
    expect(session.state).toBe("running");
    expect(prisma.computer.upsert).not.toHaveBeenCalled();
  });

  it("container voltou com outro id: esquece a linha velha e reprovisiona", async () => {
    const { deps, session } = harness("other-id");

    await expect(bootComputer(deps, "bot-b", context)).rejects.toThrow("BOOT-PATH");

    expect(session.state).toBe("stopped");
  });
});

describe("ensureWorkspaceComputer com o container parado", () => {
  it("religa e devolve a mesma referência, sem passar pelo provision", async () => {
    const computer = {
      id: "comp-1",
      workspaceId: "ws-1",
      userId: "user-1",
      kind: "docker",
      state: "running",
      providerRef: "container-workspace",
      bootClaimToken: null as string | null,
    };
    let running = false;
    const prisma = {
      computer: {
        upsert: vi.fn(async () => computer),
        findUnique: vi.fn(async () => computer),
        updateMany: vi.fn(async () => {
          throw new Error("FORGOT-THE-ROW");
        }),
      },
      desktopSession: { updateMany: vi.fn(async () => ({ count: 0 })) },
    } as unknown as PrismaClient;
    const sandbox = {
      presence: vi.fn(async () => (running ? "running" : "stopped")),
      start: vi.fn(async (ref: ComputerRef) => {
        running = true;
        return ref;
      }),
      provision: vi.fn(async () => {
        throw new Error("PROVISION-PATH");
      }),
    } as unknown as SandboxProvider;

    const ref = await ensureWorkspaceComputer(
      { prisma, sandbox, home: { resolve: () => "/tmp/home" } as never, dataDir: "/tmp/data" },
      "ws-1",
      "user-1",
      context,
      { kind: "docker" },
    );

    expect(ref.providerRef).toBe("container-workspace");
    expect(sandbox.start).toHaveBeenCalledTimes(1);
    expect(sandbox.provision).not.toHaveBeenCalled();
    expect(prisma.computer.updateMany).not.toHaveBeenCalled();
  });
});
