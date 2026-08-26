import { call, ORPCError } from "@orpc/server";
import type { Actor } from "@quibt/contracts";
import type { PrismaClient } from "@quibt/db";
import { describe, expect, it } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

const actor: Actor = {
  userId: "user-1",
  workspaceId: "ws-1",
  workspaceRole: "owner",
  email: "owner@example.com",
  isDeploymentOwner: true,
};

const context = { actor };

/**
 * O que `models.connect` grava, e o fetch que a sondagem usa. O Prisma falso registra
 * cada credencial criada: o teste olha ali para saber se a chave errada foi guardada.
 */
function harness(respond: (url: string) => Response | never, env: Partial<RouterDeps["env"]> = {}) {
  const created: Array<Record<string, unknown>> = [];
  const probed: string[] = [];
  const tx = {
    secret: {
      create: async (args: { data: Record<string, unknown> }) => ({ id: args.data.id }),
    },
    userModelCredential: {
      updateMany: async () => ({ count: 0 }),
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: "cred-1", ...args.data };
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;
  const probeFetch = (async (url: string | URL | Request) => {
    probed.push(String(url));
    return respond(String(url));
  }) as typeof fetch;
  const deps = {
    prisma,
    secrets: {
      put: async (plaintext: string) => ({ id: "s", ciphertext: `enc:${plaintext}` }),
      load: (ciphertext: string) => ciphertext.replace(/^enc:/, ""),
    },
    probeFetch,
    env: {
      defaultProvider: "openrouter",
      defaultModel: "model",
      screenProxySecret: "secret",
      sandboxProvider: "docker",
      agentRuntime: "pi",
      ...env,
    },
  } as unknown as RouterDeps;
  return { router: createRouter(deps), created, probed };
}

describe("models.connect confere a chave antes de gravar", () => {
  it("recusa a chave que o OpenRouter recusa, em português, e não grava nada", async () => {
    const { router, created, probed } = harness(() => new Response("", { status: 401 }));
    const attempt = call(
      router.models.connect,
      { provider: "openrouter", apiKey: "sk-or-v1-wrong-key" },
      { context },
    );
    await expect(attempt).rejects.toBeInstanceOf(ORPCError);
    await expect(attempt).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/^Chave recusada pelo OpenRouter/),
      data: { code: "MODEL_CREDENTIAL_REJECTED", provider: "openrouter" },
    });
    expect(probed).toEqual(["https://openrouter.ai/api/v1/auth/key"]);
    expect(created).toHaveLength(0);
  });

  it("diz que está sem crédito quando o OpenRouter responde 402", async () => {
    const { router, created } = harness(() => new Response("", { status: 402 }));
    await expect(
      call(
        router.models.connect,
        { provider: "openrouter", apiKey: "sk-or-v1-broke" },
        { context },
      ),
    ).rejects.toMatchObject({ message: expect.stringMatching(/^Sem crédito na OpenRouter/) });
    expect(created).toHaveLength(0);
  });

  it("grava a chave que o provedor confirmou e a torna padrão", async () => {
    const { router, created } = harness(() => new Response("{}", { status: 200 }));
    const credential = await call(
      router.models.connect,
      { provider: "openrouter", apiKey: "sk-or-v1-good-key", modelId: "deepseek/x" },
      { context },
    );
    expect(credential).toMatchObject({ provider: "openrouter", hasKey: true, isDefault: true });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ provider: "openrouter", defaultModel: "deepseek/x" });
  });

  it("aponta o Ollama parado sem gravar a URL", async () => {
    const { router, created, probed } = harness(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    await expect(
      call(
        router.models.connect,
        { provider: "ollama", apiKey: "http://127.0.0.1:11434", modelId: "llama3.2" },
        { context },
      ),
    ).rejects.toMatchObject({
      message: "O Ollama não respondeu em http://127.0.0.1:11434. Abra o Ollama e tente de novo.",
    });
    expect(probed).toEqual(["http://127.0.0.1:11434/api/tags"]);
    expect(created).toHaveLength(0);
  });

  it("aceita sem sondar os provedores que o probe não conhece", async () => {
    const { router, created, probed } = harness(() => {
      throw new Error("must not be called");
    });
    await call(
      router.models.connect,
      { provider: "anthropic", apiKey: "sk-ant-anything", modelId: "claude-x" },
      { context },
    );
    expect(probed).toEqual([]);
    expect(created).toHaveLength(1);
  });

  it("não sonda no emulador dos testes, que nunca fala com provedor", async () => {
    const { router, created, probed } = harness(() => new Response("", { status: 401 }), {
      agentRuntime: "scripted",
    });
    await call(
      router.models.connect,
      { provider: "openrouter", apiKey: "sk-or-v1-fake-for-journeys", modelId: "scripted" },
      { context },
    );
    expect(probed).toEqual([]);
    expect(created).toHaveLength(1);
  });
});
