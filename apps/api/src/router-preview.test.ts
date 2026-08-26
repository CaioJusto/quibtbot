import { call } from "@orpc/server";
import type { Actor } from "@quibt/contracts";
import type { PrismaClient } from "@quibt/db";
import { describe, expect, it } from "vitest";
import { createRouter, previewImagePath, type RouterDeps } from "./router.js";

const owner: Actor = {
  userId: "user-1",
  workspaceId: "ws-1",
  workspaceRole: "owner",
  email: "owner@example.com",
  isDeploymentOwner: true,
};

type Executed = { argv: string[]; cwd: string };

/**
 * Um router com um sandbox de mentira que anota cada comando e devolve o que o teste
 * mandar. O cache de retratos da API é por bot e vive no módulo, então cada teste usa um
 * bot com id próprio para não ler o retrato do teste anterior.
 */
function harness(botId: string, respond: (argv: string[]) => { stdout: string; code: number }) {
  const desktop = {
    botId,
    workspaceId: "ws-1",
    display: 1,
    providerRef: "container-1",
    screenUrl: null,
    state: "running",
    controlHolder: "bot",
    controlLeaseId: null,
    controlLeaseUserId: null,
    controlLeaseExpiresAt: null,
    controlFence: 0,
    computer: { id: "computer-1", kind: "docker", providerRef: "container-1" },
  };
  const bot = {
    id: botId,
    workspaceId: "ws-1",
    name: "Chief",
    thread: null,
    desktopSession: desktop,
  };
  const executed: Executed[] = [];
  const prisma = {
    bot: { findFirst: async () => bot, findUnique: async () => bot },
    member: { findFirst: async () => ({ id: "m1", role: "owner" }) },
    desktopSession: { findUnique: async () => desktop },
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    sandbox: {
      async *execute(_computer: unknown, command: { argv: string[]; cwd: string }) {
        executed.push({ argv: command.argv, cwd: command.cwd });
        const result = respond(command.argv);
        if (result.stdout) yield { type: "stdout", data: result.stdout };
        yield { type: "exit", code: result.code };
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
  return { router: createRouter(deps), executed };
}

/** O último argumento dos dois comandos é o caminho do PNG (`$1` no script). */
const targetOf = (step: Executed) => step.argv.at(-1);

describe("previewImagePath", () => {
  it("dá a cada bot o seu próprio arquivo no /tmp que os bots dividem", () => {
    expect(previewImagePath("bot-a")).toBe("/tmp/quibt-preview-bot-a.png");
    expect(previewImagePath("bot-b")).not.toBe(previewImagePath("bot-a"));
  });

  it("não deixa o id virar caminho: só letras, números, hífen e sublinhado", () => {
    expect(previewImagePath("../etc/x y")).toBe("/tmp/quibt-preview-etcxy.png");
    expect(previewImagePath("///")).toBe("/tmp/quibt-preview-bot.png");
  });
});

describe("computer.preview", () => {
  it("tira o retrato num arquivo só deste bot e o apaga depois de ler", async () => {
    const { router, executed } = harness("bot-preview-1", (argv) =>
      argv[2]?.startsWith("base64") ? { stdout: "QUJD", code: 0 } : { stdout: "", code: 0 },
    );
    const result = await call(
      router.computer.preview,
      { botId: "bot-preview-1" },
      { context: { actor: owner } },
    );
    expect(result.image).toBe("data:image/png;base64,QUJD");
    expect(executed).toHaveLength(2);
    const [shot, encode] = executed as [Executed, Executed];
    expect(targetOf(shot)).toBe("/tmp/quibt-preview-bot-preview-1.png");
    expect(targetOf(encode)).toBe("/tmp/quibt-preview-bot-preview-1.png");
    // Nunca o nome compartilhado de antes: era ele que misturava a tela de dois bots.
    expect(shot.argv.join(" ")).not.toContain("/tmp/quibt-preview.png");
    // Lê e apaga no mesmo comando, mantendo o código do base64 como resultado.
    expect(encode.argv[2]).toBe('base64 -w0 "$1"; status=$?; rm -f -- "$1"; exit $status');
  });

  it("dois bots no mesmo computador nunca escrevem o mesmo arquivo", async () => {
    const a = harness("bot-preview-2a", () => ({ stdout: "QQ==", code: 0 }));
    const b = harness("bot-preview-2b", () => ({ stdout: "Qg==", code: 0 }));
    await call(
      a.router.computer.preview,
      { botId: "bot-preview-2a" },
      { context: { actor: owner } },
    );
    await call(
      b.router.computer.preview,
      { botId: "bot-preview-2b" },
      { context: { actor: owner } },
    );
    expect(targetOf(a.executed[0] as Executed)).not.toBe(targetOf(b.executed[0] as Executed));
  });

  it("devolve sem imagem quando o screenshot falha, sem tentar ler o arquivo", async () => {
    const { router, executed } = harness("bot-preview-3", () => ({ stdout: "", code: 1 }));
    const result = await call(
      router.computer.preview,
      { botId: "bot-preview-3" },
      { context: { actor: owner } },
    );
    expect(result).toEqual({ image: null, capturedAt: null });
    expect(executed).toHaveLength(1);
  });
});
