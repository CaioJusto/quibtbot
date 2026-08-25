import type { AdapterContext, ComputerRef, ProcessEvent } from "@quibt/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computerIdentity,
  DockerSandboxProvider,
  publicComputerBootMessage,
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

  it("só o 404 do supervisor conta como sumiço", async () => {
    const provider = new DockerSandboxProvider("http://supervisor:7091", "token");
    captureFetch(new Response("{}", { status: 404 }));
    expect(await provider.exists(ref(), context())).toBe(false);
    // 403 e 500 são problema nosso, não prova de que o container morreu: dizer que sumiu
    // apagaria a linha do banco e provisionaria outro computador por engano.
    captureFetch(new Response("{}", { status: 403 }));
    expect(await provider.exists(ref(), context())).toBe(true);
    captureFetch(new Response("{}", { status: 500 }));
    expect(await provider.exists(ref(), context())).toBe(true);
  });
});
