import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { isProbedProvider, PROBED_PROVIDERS, probeModelCredential } from "./model-probe.js";

function fakeFetch(
  respond: (url: string, init?: RequestInit) => Response | Promise<Response> | never,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function refused(code: string) {
  return Object.assign(new TypeError("fetch failed"), { cause: { code } });
}

function authHeader(call: { init?: RequestInit } | undefined): string | undefined {
  const headers = call?.init?.headers as Record<string, string> | undefined;
  return headers?.authorization;
}

describe("probeModelCredential — OpenRouter", () => {
  it("confirma a chave em /auth/key com o Bearer", async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response("{}", { status: 200 }));
    const result = await probeModelCredential(
      { provider: "openrouter", apiKey: " sk-or-v1-abc " },
      { fetchImpl },
    );
    expect(result).toEqual({
      ok: true,
      probed: true,
      message: "Chave confirmada pela OpenRouter.",
    });
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/auth/key");
    expect(authHeader(calls[0])).toBe("Bearer sk-or-v1-abc");
  });

  it("traduz 401 e 403 em chave recusada", async () => {
    for (const status of [401, 403]) {
      const { fetchImpl } = fakeFetch(() => new Response("Unauthorized", { status }));
      const result = await probeModelCredential(
        { provider: "openrouter", apiKey: "sk-or-v1-wrong" },
        { fetchImpl },
      );
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/^Chave recusada pelo OpenRouter/);
      expect(result.message).toContain("openrouter.ai/keys");
    }
  });

  it("traduz 402 em sem crédito", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("Payment Required", { status: 402 }));
    const result = await probeModelCredential(
      { provider: "openrouter", apiKey: "sk-or-v1-broke" },
      { fetchImpl },
    );
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toMatch(/^Sem crédito na OpenRouter/);
  });

  it("não deixa passar um 500 nem uma queda de rede como chave boa", async () => {
    const down = fakeFetch(() => new Response("oops", { status: 503 }));
    expect(
      await probeModelCredential({ provider: "openrouter", apiKey: "sk-or-v1-x" }, down),
    ).toMatchObject({ ok: false, message: expect.stringContaining("503") });

    const offline = fakeFetch(() => {
      throw refused("ENOTFOUND");
    });
    const result = await probeModelCredential(
      { provider: "openrouter", apiKey: "sk-or-v1-x" },
      offline,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Verifique a internet");
  });

  it("diz em português o que a rede fez, sem o código cru do Node", async () => {
    const traduzidos: Array<[string, string]> = [
      ["ENOTFOUND", "não achei o endereço"],
      ["EAI_AGAIN", "não achei o endereço"],
      ["ECONNREFUSED", "conexão recusada"],
      ["ECONNRESET", "a conexão caiu"],
      ["ETIMEDOUT", "a conexão caiu"],
    ];
    for (const [code, palavras] of traduzidos) {
      const { fetchImpl } = fakeFetch(() => {
        throw refused(code);
      });
      const result = await probeModelCredential(
        { provider: "openrouter", apiKey: "sk-or-v1-x" },
        { fetchImpl },
      );
      expect(result.message).toContain(palavras);
      expect(result.message).not.toContain(code);
    }
    // Um código que não está na lista some da frase em vez de virar ruído.
    const { fetchImpl } = fakeFetch(() => {
      throw refused("EMFILE");
    });
    const unknown = await probeModelCredential(
      { provider: "openrouter", apiKey: "sk-or-v1-x" },
      { fetchImpl },
    );
    expect(unknown.message).toBe(
      "Não consegui falar com a OpenRouter. Verifique a internet e tente de novo.",
    );
  });

  it("desiste sozinha: passa um AbortSignal e o estouro vira 'demorou demais'", async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response("{}", { status: 200 }));
    await probeModelCredential({ provider: "openrouter", apiKey: "sk-or-v1-x" }, { fetchImpl });
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);

    // Um servidor que aceita a conexão e nunca responde: só o signal termina a espera.
    const hanging = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const result = await probeModelCredential(
      { provider: "openrouter", apiKey: "sk-or-v1-x" },
      { fetchImpl: hanging.fetchImpl, timeoutMs: 10 },
    );
    expect(result).toEqual({
      ok: false,
      message:
        "Não consegui falar com a OpenRouter (demorou demais). Verifique a internet e tente de novo.",
    });
  });

  it("nomeia o tempo esgotado em vez de 'TimeoutError'", async () => {
    const { fetchImpl } = fakeFetch(() => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    });
    const result = await probeModelCredential(
      { provider: "openrouter", apiKey: "sk-or-v1-x" },
      { fetchImpl },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("demorou demais");
    expect(result.message).not.toContain("TimeoutError");
  });
});

describe("probeModelCredential — xAI", () => {
  it("consulta /v1/models com a chave", async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response("{}", { status: 200 }));
    const result = await probeModelCredential(
      { provider: "xai", apiKey: "xai-abc" },
      { fetchImpl },
    );
    expect(result).toMatchObject({ ok: true, probed: true });
    expect(calls[0]?.url).toBe("https://api.x.ai/v1/models");
    expect(authHeader(calls[0])).toBe("Bearer xai-abc");
  });

  it("recusa a chave errada em português", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("", { status: 401 }));
    const result = await probeModelCredential(
      { provider: "xai", apiKey: "xai-wrong" },
      { fetchImpl },
    );
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toMatch(/^Chave recusada pela xAI/);
  });
});

describe("probeModelCredential — modelos locais", () => {
  it("bate em {url}/api/tags do Ollama e aceita quando responde", async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('{"models":[]}', { status: 200 }));
    const result = await probeModelCredential(
      { provider: "ollama", apiKey: "http://127.0.0.1:11434/" },
      { fetchImpl },
    );
    expect(result).toEqual({
      ok: true,
      probed: true,
      base: "http://127.0.0.1:11434",
      message: "Servidor confirmado em http://127.0.0.1:11434.",
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:11434/api/tags");
    expect(calls[0]?.init?.headers).toBeUndefined();
  });

  it("aceita a URL com /v1 que o runtime usa e devolve a raiz como forma canônica", async () => {
    // `http://host:11434/v1` é a única forma que o `chat/completions` do Ollama atende, e
    // era recusada: a sonda batia em /v1/api/tags. As duas formas viram a mesma raiz.
    for (const colada of ["http://127.0.0.1:11434/v1", "http://127.0.0.1:11434/v1/"]) {
      const { fetchImpl, calls } = fakeFetch(() => new Response('{"models":[]}', { status: 200 }));
      const result = await probeModelCredential(
        { provider: "ollama", apiKey: colada },
        { fetchImpl },
      );
      expect(result).toMatchObject({ ok: true, base: "http://127.0.0.1:11434" });
      expect(calls[0]?.url).toBe("http://127.0.0.1:11434/api/tags");
    }
  });

  it("não vira sonda de porta: não segue redirect, não devolve o status e olha o corpo", async () => {
    // A frase é a mesma de uma porta fechada: quem sonda não descobre se algo atendeu.
    const fechada =
      "O Ollama não respondeu em http://127.0.0.1:9200. Abra o Ollama e tente de novo.";
    const outroServico = fakeFetch(() => new Response('{"cluster_name":"elasticsearch"}'));
    const result = await probeModelCredential(
      { provider: "ollama", apiKey: "http://127.0.0.1:9200" },
      outroServico,
    );
    expect(result).toEqual({ ok: false, message: fechada });
    expect(outroServico.calls[0]?.init?.redirect).toBe("manual");

    for (const status of [301, 404, 500]) {
      const { fetchImpl } = fakeFetch(() => new Response("", { status }));
      const desviado = await probeModelCredential(
        { provider: "ollama", apiKey: "http://127.0.0.1:9200" },
        { fetchImpl },
      );
      expect(desviado.message).toBe(fechada);
      expect(desviado.message).not.toContain(String(status));
    }

    const recusada = fakeFetch(() => {
      throw refused("ECONNREFUSED");
    });
    expect(
      (
        await probeModelCredential(
          { provider: "ollama", apiKey: "http://127.0.0.1:9200" },
          recusada,
        )
      ).message,
    ).toBe(fechada);
  });

  it("diz para abrir o Ollama quando a porta recusa ou demora", async () => {
    const closed = fakeFetch(() => {
      throw refused("ECONNREFUSED");
    });
    expect(
      await probeModelCredential({ provider: "ollama", apiKey: "http://127.0.0.1:11434" }, closed),
    ).toEqual({
      ok: false,
      message: "O Ollama não respondeu em http://127.0.0.1:11434. Abra o Ollama e tente de novo.",
    });

    const slow = fakeFetch(() => {
      const error = new Error("timeout");
      error.name = "TimeoutError";
      throw error;
    });
    expect(
      await probeModelCredential({ provider: "ollama", apiKey: "http://127.0.0.1:11434" }, slow),
    ).toMatchObject({ ok: false, message: expect.stringContaining("Abra o Ollama") });
  });

  it("bate em {url}/models do servidor OpenAI-compatible", async () => {
    const { fetchImpl, calls } = fakeFetch(
      () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const result = await probeModelCredential(
      { provider: "openai-compatible", apiKey: "http://127.0.0.1:1234/v1" },
      { fetchImpl },
    );
    expect(result).toMatchObject({ ok: true, probed: true });
    expect(calls[0]?.url).toBe("http://127.0.0.1:1234/v1/models");

    const closed = fakeFetch(() => {
      throw refused("ECONNREFUSED");
    });
    const down = await probeModelCredential(
      { provider: "openai-compatible", apiKey: "http://127.0.0.1:1234/v1" },
      closed,
    );
    expect(down.ok).toBe(false);
    expect(down.message).toContain("não respondeu em http://127.0.0.1:1234/v1");
    expect(down.message).toContain("LM Studio");
  });

  it("pede uma URL quando o campo não é uma", async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response("{}", { status: 200 }));
    const result = await probeModelCredential(
      { provider: "ollama", apiKey: "sk-or-v1-not-a-url" },
      { fetchImpl },
    );
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("Cole a URL") });
    expect(calls).toHaveLength(0);
  });
});

describe("probeModelCredential — provedores que não são sondados", () => {
  it("aceita a chave sem chamar ninguém", async () => {
    const { fetchImpl, calls } = fakeFetch(() => {
      throw new Error("must not be called");
    });
    for (const provider of ["anthropic", "openai", "google", "scripted"]) {
      const result = await probeModelCredential({ provider, apiKey: "sk-any" }, { fetchImpl });
      expect(result).toMatchObject({ ok: true, probed: false });
    }
    expect(calls).toHaveLength(0);
  });

  it("documenta quem é sondado", () => {
    expect([...PROBED_PROVIDERS]).toEqual(["openrouter", "xai", "ollama", "openai-compatible"]);
    expect(isProbedProvider("openrouter")).toBe(true);
    expect(isProbedProvider("anthropic")).toBe(false);
  });
});

describe("probeModelCredential — para onde a sonda pode ir", () => {
  const ok = () => new Response('{"models":[]}', { status: 200 });
  const lmStudio = () => new Response(JSON.stringify({ data: [] }), { status: 200 });

  /** A frase única de recusa: não diz se o endereço existe, responde ou está fechado. */
  const recusa =
    "O Ollama precisa estar no seu computador ou num endereço público. Use http://127.0.0.1:11434 (ou host.docker.internal, se o Quibt roda em Docker).";

  it("deixa o Ollama e o LM Studio locais passarem", async () => {
    for (const url of [
      "http://127.0.0.1:11434",
      "http://127.0.0.2:11434",
      "http://localhost:11434",
    ]) {
      const { fetchImpl, calls } = fakeFetch(ok);
      const result = await probeModelCredential({ provider: "ollama", apiKey: url }, { fetchImpl });
      expect(result).toMatchObject({ ok: true, probed: true });
      expect(calls).toHaveLength(1);
    }
    const { fetchImpl, calls } = fakeFetch(lmStudio);
    const studio = await probeModelCredential(
      { provider: "openai-compatible", apiKey: "http://localhost:1234/v1" },
      { fetchImpl },
    );
    expect(studio).toMatchObject({ ok: true, probed: true });
    expect(calls[0]?.url).toBe("http://localhost:1234/v1/models");
  });

  it("deixa o host.docker.internal passar — é ele que sai do container", async () => {
    const { fetchImpl, calls } = fakeFetch(ok);
    const result = await probeModelCredential(
      { provider: "ollama", apiKey: "http://host.docker.internal:11434" },
      { fetchImpl },
    );
    expect(result).toMatchObject({ ok: true, base: "http://host.docker.internal:11434" });
    expect(calls[0]?.url).toBe("http://host.docker.internal:11434/api/tags");
  });

  it("recusa o endereço de metadados da nuvem sem bater nele", async () => {
    const { fetchImpl, calls } = fakeFetch(ok);
    const result = await probeModelCredential(
      { provider: "ollama", apiKey: "http://169.254.169.254/latest/meta-data" },
      { fetchImpl },
    );
    expect(result).toEqual({ ok: false, message: recusa });
    expect(calls).toHaveLength(0);
  });

  it("recusa a rede privada e o link-local, com a mesma frase", async () => {
    for (const host of [
      "10.0.0.5:9200",
      "172.16.3.4:8080",
      "172.31.0.1:80",
      "192.168.1.10:11434",
      "169.254.10.10:11434",
      "100.64.0.1:11434",
      "0.0.0.0:11434",
      "[fd00::1]:11434",
    ]) {
      const { fetchImpl, calls } = fakeFetch(ok);
      const result = await probeModelCredential(
        { provider: "ollama", apiKey: `http://${host}` },
        { fetchImpl },
      );
      expect(result).toEqual({ ok: false, message: recusa });
      expect(calls).toHaveLength(0);
    }
  });

  it("olha o IP resolvido, não o texto do host (DNS rebinding)", async () => {
    const privado = fakeFetch(ok);
    const result = await probeModelCredential(
      { provider: "ollama", apiKey: "http://ollama.interno.example.com:11434" },
      { fetchImpl: privado.fetchImpl, resolveHost: async () => [{ address: "192.168.0.9" }] },
    );
    expect(result).toEqual({ ok: false, message: recusa });
    expect(privado.calls).toHaveLength(0);

    // Um nome que resolve para o loopback também não vale: só o literal 127.x é local.
    const voltando = fakeFetch(ok);
    const rebind = await probeModelCredential(
      { provider: "ollama", apiKey: "http://rebind.example.com:11434" },
      { fetchImpl: voltando.fetchImpl, resolveHost: async () => [{ address: "127.0.0.1" }] },
    );
    expect(rebind).toEqual({ ok: false, message: recusa });
    expect(voltando.calls).toHaveLength(0);

    // Um dos IPs público e outro privado: recusa, para não escolher o bom por sorte.
    const misto = fakeFetch(ok);
    const meio = await probeModelCredential(
      { provider: "ollama", apiKey: "http://misto.example.com:11434" },
      {
        fetchImpl: misto.fetchImpl,
        resolveHost: async () => [{ address: "93.184.216.34" }, { address: "10.1.2.3" }],
      },
    );
    expect(meio).toEqual({ ok: false, message: recusa });
    expect(misto.calls).toHaveLength(0);
  });

  it("deixa um servidor público do dono passar", async () => {
    const { fetchImpl, calls } = fakeFetch(lmStudio);
    const result = await probeModelCredential(
      { provider: "openai-compatible", apiKey: "https://modelos.example.com/v1" },
      { fetchImpl, resolveHost: async () => [{ address: "93.184.216.34" }] },
    );
    expect(result).toMatchObject({ ok: true, probed: true });
    expect(calls[0]?.url).toBe("https://modelos.example.com/v1/models");
  });

  it("recusa quem embute usuário e senha, e quem não é http(s)", async () => {
    for (const url of ["http://user:senha@127.0.0.1:11434", "file:///etc/passwd"]) {
      const { fetchImpl, calls } = fakeFetch(ok);
      const result = await probeModelCredential({ provider: "ollama", apiKey: url }, { fetchImpl });
      expect(result.ok).toBe(false);
      expect(calls).toHaveLength(0);
    }
  });

  it("dentro do container, o conselho do host.docker.internal não denuncia a porta", async () => {
    const respostas = [
      () => new Response('{"cluster_name":"elasticsearch"}'),
      () => {
        throw refused("ECONNREFUSED");
      },
      () => {
        const error = new Error("timeout");
        error.name = "TimeoutError";
        throw error;
      },
    ];
    const frases = new Set<string>();
    for (const respond of respostas) {
      const { fetchImpl } = fakeFetch(respond);
      const result = await probeModelCredential(
        { provider: "ollama", apiKey: "http://127.0.0.1:9200" },
        { fetchImpl, insideContainer: true },
      );
      expect(result.ok).toBe(false);
      frases.add(result.message);
    }
    expect(frases.size).toBe(1);
    expect([...frases][0]).toContain("host.docker.internal");
  });
});

describe("probeModelCredential — a conferência vale até o socket", () => {
  const servers: Array<{ close: () => void }> = [];
  afterAll(() => {
    for (const server of servers) server.close();
  });

  it("recusa o nome que é público no preflight e privado na hora de conectar", async () => {
    // A janela do rebinding: a primeira resolução mostra um IP público e a segunda, a de
    // conectar, já aponta para dentro da rede. Sem `fetchImpl`, quem abre o socket é o
    // transporte de verdade — e ele confere o IP que vai usar.
    const answers = [[{ address: "93.184.216.34" }]];
    let lookups = 0;
    const result = await probeModelCredential(
      { provider: "ollama", apiKey: "http://rebind.example.com:11434" },
      {
        resolveHost: async () => {
          lookups += 1;
          return answers.shift() ?? [{ address: "169.254.169.254" }];
        },
      },
    );
    expect(result).toEqual({
      ok: false,
      message:
        "O Ollama não respondeu em http://rebind.example.com:11434. Abra o Ollama e tente de novo.",
    });
    // Duas resoluções: a do preflight e a que o socket usou. A segunda é a que decide.
    expect(lookups).toBeGreaterThanOrEqual(2);
  });

  it("recusa um redirect para o metadado da nuvem, sem seguir o salto", async () => {
    for (const location of ["http://169.254.169.254/latest/meta-data", "https://10.0.0.5/key"]) {
      const { fetchImpl, calls } = fakeFetch(
        () => new Response("", { status: 302, headers: { location } }),
      );
      const result = await probeModelCredential(
        { provider: "openrouter", apiKey: "sk-or-v1-x" },
        { fetchImpl },
      );
      expect(result).toEqual({
        ok: false,
        message: "Não consegui falar com a OpenRouter. Verifique a internet e tente de novo.",
      });
      // O Bearer não foi para o endereço interno: a segunda requisição não existiu.
      expect(calls).toHaveLength(1);
    }
  });

  it("segue um redirect público e confere o salto pela mesma política", async () => {
    const { fetchImpl, calls } = fakeFetch((url) =>
      url.endsWith("/auth/key")
        ? new Response("", {
            status: 302,
            headers: { location: "https://openrouter.ai/api/v1/auth/key2" },
          })
        : new Response("{}", { status: 200 }),
    );
    const result = await probeModelCredential(
      { provider: "openrouter", apiKey: "sk-or-v1-x" },
      { fetchImpl, resolveHost: async () => [{ address: "93.184.216.34" }] },
    );
    expect(result).toMatchObject({ ok: true, probed: true });
    expect(calls.map((call) => call.url)).toEqual([
      "https://openrouter.ai/api/v1/auth/key",
      "https://openrouter.ai/api/v1/auth/key2",
    ]);
  });

  it("o Ollama e o LM Studio locais continuam respondendo pelo socket de verdade", async () => {
    const server = createServer((req, res) => {
      const body = req.url === "/api/tags" ? { models: [] } : { data: [] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    // Sem `fetchImpl`: é o transporte fixado que abre a conexão.
    const ollama = await probeModelCredential({
      provider: "ollama",
      apiKey: `http://127.0.0.1:${port}`,
    });
    expect(ollama).toMatchObject({ ok: true, probed: true, base: `http://127.0.0.1:${port}` });

    const studio = await probeModelCredential({
      provider: "openai-compatible",
      apiKey: `http://127.0.0.1:${port}/v1`,
    });
    expect(studio).toMatchObject({ ok: true, probed: true });
  });
});
