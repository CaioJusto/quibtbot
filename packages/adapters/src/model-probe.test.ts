import { describe, expect, it } from "vitest";
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
    expect(result.message).toContain("ENOTFOUND");
    expect(result.message).toContain("Verifique a internet");
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
      message: "Servidor confirmado em http://127.0.0.1:11434.",
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:11434/api/tags");
    expect(calls[0]?.init?.headers).toBeUndefined();
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
    const { fetchImpl, calls } = fakeFetch(() => new Response("{}", { status: 200 }));
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
