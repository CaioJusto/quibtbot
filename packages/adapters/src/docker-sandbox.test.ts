import type { AdapterContext, ComputerRef, ProcessEvent } from "@quibt/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPUTER_REVIVED_NOTE,
  computerIdentity,
  DockerSandboxProvider,
  isComputerAlreadyStoppedError,
  isComputerMissingError,
  publicComputerBootMessage,
  SupervisorRequestError,
  supervisorErrorMessage,
} from "./docker-sandbox.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function context(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    operationId: "op",
    traceId: "trace",
    workspaceId: "ws-1",
    userId: "u-1",
    signal: new AbortController().signal,
    ...overrides,
  };
}

function ref(overrides: Partial<ComputerRef> = {}): ComputerRef {
  return {
    id: "container-1",
    botId: "bot-1",
    kind: "docker",
    providerRef: "container-1",
    ...overrides,
  };
}

function captureFetch(response: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response;
  });
  return calls;
}

/** Uma `Response` nova por chamada: o corpo só pode ser lido uma vez. */
function answerEvery(status: number, body: unknown = {}) {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status }));
}

describe("supervisor identity header", () => {
  it("prefers context bot over ref for shared workspace sessions", () => {
    expect(computerIdentity({ botId: "bot-1" }, { botId: "bot-2" })).toBe("bot-2");
    expect(computerIdentity({ botId: "" }, { botId: "bot-2" })).toBe("bot-2");
    expect(computerIdentity({}, {})).toBeUndefined();
  });

  it("always sends x-quibt-bot-id on stop, so the supervisor does not answer 403", async () => {
    const calls = captureFetch(new Response("{}", { status: 200 }));
    const provider = new DockerSandboxProvider("http://supervisor", "token");
    await provider.stop(ref({ botId: "" }), context({ botId: "bot-9" }));
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-quibt-bot-id"]).toBe("bot-9");
  });
});

describe("supervisor error messages", () => {
  it("names the reason behind each hardened status", () => {
    expect(supervisorErrorMessage("stop", 400)).toContain("invalid request");
    expect(supervisorErrorMessage("stop", 403)).toContain(
      "missing or mismatched computer identity",
    );
    expect(supervisorErrorMessage("stop", 404)).toContain("computer or session not found");
    expect(supervisorErrorMessage("provision", 409)).toContain("the display is already taken");
    expect(supervisorErrorMessage("provision", 500, "boom")).toContain("boom");
  });

  it("surfaces the identity rejection instead of a bare status", async () => {
    captureFetch(new Response("missing computer identity", { status: 403 }));
    const provider = new DockerSandboxProvider("http://supervisor", "token");
    await expect(provider.stop(ref(), context())).rejects.toThrow(
      /missing or mismatched computer identity/,
    );
  });
});

describe("keepAlive", () => {
  it("inspects the supervisor session so a wedged noVNC is repaired", async () => {
    const calls = captureFetch(
      new Response(JSON.stringify({ screenUrl: "http://x/embed.html" }), { status: 200 }),
    );
    const provider = new DockerSandboxProvider("http://supervisor", "token");
    await provider.keepAlive(ref(), context());
    expect(calls[0]!.url).toBe("http://supervisor/computers/container-1");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-quibt-bot-id"]).toBe("bot-1");
    expect(headers["x-quibt-workspace-id"]).toBe("ws-1");
  });

  it("does nothing without a workspace, so a bare heartbeat cannot 403 the supervisor", async () => {
    const calls = captureFetch(new Response("{}", { status: 200 }));
    const provider = new DockerSandboxProvider("http://supervisor", "token");
    await provider.keepAlive(ref());
    expect(calls).toEqual([]);
  });
});

describe("provision contract", () => {
  it("still sends the homePath the supervisor schema requires", async () => {
    const calls = captureFetch(
      new Response(JSON.stringify({ id: "container-1", display: 10 }), { status: 200 }),
    );
    const provider = new DockerSandboxProvider("http://supervisor", "token");
    await provider.provision({ botId: "bot-1", homePath: "/data/homes/bot-1" }, context());
    // The supervisor ignores the value (it mounts workspaceHomePath) but rejects an empty body.
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      botId: "bot-1",
      workspaceId: "ws-1",
      homePath: "/data/homes/bot-1",
    });
  });
});

describe("Docker sandbox command timeout", () => {
  it("sends the bounded timeout to the supervisor and preserves its honest result", async () => {
    const calls = captureFetch(
      Response.json({
        stdout: "partial output\n",
        stderr: "command timed out after 75 ms\n",
        code: 124,
      }),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const events: ProcessEvent[] = [];

    for await (const event of provider.execute(
      ref(),
      { argv: ["sleep", "10"], timeoutMs: 75 },
      context(),
    )) {
      events.push(event);
    }

    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      argv: ["sleep", "10"],
      cwd: "/home/quibt",
      timeoutMs: 75,
    });
    expect(events).toEqual([
      { type: "stdout", data: "partial output\n" },
      { type: "stderr", data: "command timed out after 75 ms\n" },
      { type: "exit", code: 124 },
    ]);
  });
});

describe("public computer boot message", () => {
  it("translates EAGAIN instead of leaking a 500", () => {
    expect(
      publicComputerBootMessage(
        new Error(
          "sandbox provision failed: 500 supervisor error (O computador não ligou: o Docker recusou o processo (EAGAIN). Isso costuma ser RLIMIT_NPROC do uid 1000 no host, não falta de memória.)",
        ),
      ),
    ).toMatch(/EAGAIN/);
  });

  it("unwraps a supervisor JSON error body", () => {
    expect(
      supervisorErrorMessage("provision", 500, '{"error":"O computador saiu com código 255"}'),
    ).toContain("O computador saiu com código 255");
  });
});

describe("existência do computador", () => {
  it("pergunta na rota de existência e aceita a resposta sem identidade de bot", async () => {
    const calls = captureFetch(new Response(JSON.stringify({ running: true }), { status: 200 }));
    const provider = new DockerSandboxProvider("http://supervisor:7091", "token");
    expect(await provider.exists(ref({ botId: undefined }), context())).toBe(true);
    expect(calls[0]?.url).toBe("http://supervisor:7091/computers/container-1/exists");
    const headers = calls[0]?.init.headers as Record<string, string> | undefined;
    expect(headers?.["x-quibt-workspace-id"]).toBe("ws-1");
  });

  it("só o 404 do supervisor conta como sumiço; parado sai do atalho sem virar sumiço", async () => {
    const provider = new DockerSandboxProvider("http://supervisor:7091", "token");
    answerEvery(404);
    expect(await provider.exists(ref(), context())).toBe(false);
    expect(await provider.presence(ref(), context())).toBe("missing");
    // Container `Exited` depois de um reboot: existe, mas o boot precisa religar antes de
    // devolver a tela — por isso também deixa o atalho "já está ligado".
    answerEvery(200, { running: false });
    expect(await provider.exists(ref(), context())).toBe(false);
    expect(await provider.presence(ref(), context())).toBe("stopped");
    answerEvery(200, { running: true });
    expect(await provider.exists(ref(), context())).toBe(true);
    expect(await provider.presence(ref(), context())).toBe("running");
    // 403, 500 e 503 (Docker fechado) são problema nosso, não prova de que o container
    // morreu: dizer que sumiu apagaria a linha do banco e provisionaria outro por engano.
    for (const status of [403, 500, 503]) {
      answerEvery(status);
      expect(await provider.exists(ref(), context())).toBe(true);
      expect(await provider.presence(ref(), context())).toBe("unknown");
    }
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await provider.presence(ref(), context())).toBe("unknown");
  });
});

describe("religar um container parado", () => {
  it("pede o start ao supervisor e devolve a referência viva", async () => {
    const calls = captureFetch(
      new Response(JSON.stringify({ id: "container-1", running: true, revived: true }), {
        status: 200,
      }),
    );
    const provider = new DockerSandboxProvider("http://supervisor:7091", "token");
    const started = await provider.start(ref(), context());
    expect(calls[0]?.url).toBe("http://supervisor:7091/computers/container-1/start");
    expect(calls[0]?.init.method).toBe("POST");
    const headers = calls[0]?.init.headers as Record<string, string> | undefined;
    expect(headers?.["x-quibt-workspace-id"]).toBe("ws-1");
    expect(started.id).toBe("container-1");
    expect(started.providerRef).toBe("container-1");
  });

  it("um supervisor antigo (sem a rota) é 'não tem', não uma falha", async () => {
    captureFetch(new Response("Not Found", { status: 404 }));
    const provider = new DockerSandboxProvider("http://supervisor:7091", "token");
    const failure = await provider.start(ref(), context()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SupervisorRequestError);
    expect(isComputerMissingError(failure)).toBe(true);
  });

  it("Docker fechado vira a mensagem de abrir o Docker, com o código", async () => {
    captureFetch(
      new Response(
        JSON.stringify({
          error:
            "O computador estava desligado e não conseguiu religar: abra o Docker e tente de novo.",
          code: "docker-down",
        }),
        { status: 503 },
      ),
    );
    const provider = new DockerSandboxProvider("http://supervisor:7091", "token");
    const failure = await provider.start(ref(), context()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SupervisorRequestError);
    expect((failure as SupervisorRequestError).code).toBe("docker-down");
    expect((failure as Error).message).toBe(
      "O computador estava desligado e não conseguiu religar: abra o Docker e tente de novo.",
    );
    expect(publicComputerBootMessage(failure)).toMatch(/abra o Docker/);
    expect(isComputerMissingError(failure)).toBe(false);
  });
});

describe("parar o que já está parado", () => {
  it("404 no stop é 'já está desligado', não erro", async () => {
    captureFetch(new Response('{"error":"session not found"}', { status: 404 }));
    const provider = new DockerSandboxProvider("http://supervisor:7091", "token");
    await expect(provider.stop(ref(), context())).resolves.toBeUndefined();
  });

  it("outra falha do stop sobe com status, e o roteador sabe distingui-la", async () => {
    captureFetch(new Response('{"error":"boom"}', { status: 500 }));
    const provider = new DockerSandboxProvider("http://supervisor:7091", "token");
    const failure = await provider.stop(ref(), context()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SupervisorRequestError);
    expect((failure as SupervisorRequestError).status).toBe(500);
    expect(isComputerAlreadyStoppedError(failure)).toBe(false);
    expect(isComputerAlreadyStoppedError(new SupervisorRequestError("stop", 404))).toBe(true);
    // Erro comum com a mensagem antiga (provedor roteado, versão anterior) também conta.
    expect(isComputerAlreadyStoppedError(new Error(supervisorErrorMessage("stop", 404)))).toBe(
      true,
    );
    expect(isComputerAlreadyStoppedError(new Error("stop failed"))).toBe(false);
  });
});

describe("exec num container que estava parado", () => {
  async function drain(provider: DockerSandboxProvider) {
    const events: ProcessEvent[] = [];
    for await (const event of provider.execute(ref(), { argv: ["ls"] }, context())) {
      events.push(event);
    }
    return events;
  }

  it("avisa o bot que o computador foi religado antes de mostrar a saída", async () => {
    captureFetch(Response.json({ stdout: "home\n", stderr: "", code: 0, revived: true }));
    const provider = new DockerSandboxProvider("http://supervisor.test", "token");
    expect(await drain(provider)).toEqual([
      { type: "stderr", data: `${COMPUTER_REVIVED_NOTE}\n` },
      { type: "stdout", data: "home\n" },
      { type: "exit", code: 0 },
    ]);
  });

  it("com o Docker fechado diz para abrir o Docker, nunca 'computer request failed'", async () => {
    captureFetch(
      Response.json({
        stdout: "",
        stderr:
          "O computador estava desligado e não conseguiu religar: abra o Docker e tente de novo.",
        code: 1,
        errorCode: "docker-down",
      }),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "token");
    expect(await drain(provider)).toEqual([
      {
        type: "stderr",
        data: "O computador estava desligado e não conseguiu religar: abra o Docker e tente de novo.",
      },
      { type: "exit", code: 1 },
    ]);
  });

  it("um código sem frase pronta ganha a mensagem padrão em português", async () => {
    captureFetch(
      Response.json({
        stdout: "",
        stderr: "computer request failed",
        code: 1,
        errorCode: "docker-down",
      }),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "token");
    const events = await drain(provider);
    expect(events[0]).toEqual({
      type: "stderr",
      data: expect.stringMatching(/^O computador não respondeu: o Docker não está rodando/),
    });
    expect(supervisorErrorMessage("exec", 409, '{"error":"x","code":"computer-stopped"}')).toMatch(
      /^O computador está desligado/,
    );
  });
});
