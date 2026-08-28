import { createHmac } from "node:crypto";
import type { PrismaClient } from "@quibt/db";
import { describe, expect, it } from "vitest";
import {
  consumeDesktopSessionCapability,
  createApp,
  DESKTOP_CAPABILITY_HEADER,
  DESKTOP_CAPABILITY_TTL_MS,
  deploymentAllowsLocalSession,
  forwardedHops,
  internalProxyProof,
  isLoopbackAddress,
  requestClaimsLocalBrowser,
  signDesktopSessionCapability,
} from "./app.js";

const AUTH_SECRET = "test-auth-secret-32-characters-long";
const PROOF = internalProxyProof(AUTH_SECRET);

/**
 * O auto-login de dono (`POST /api/local/session`) entrega a conta inteira sem senha.
 * Ele só pode existir onde "chegar à porta" já é prova de estar no teclado: uma
 * instalação que fala consigo mesma. Estes casos são os endereços que um atacante
 * consegue produzir de fora — nenhum deles pode virar dono.
 */
function claim(input: {
  clientHost?: string;
  peerAddress?: string;
  hops?: string[];
  proxyProof?: string;
  deployIsLocal?: boolean;
}) {
  return requestClaimsLocalBrowser({
    clientHost: input.clientHost ?? "127.0.0.1:5173",
    peerAddress: input.peerAddress,
    forwardedHops: input.hops ?? [],
    proxyProof: input.proxyProof,
    authSecret: AUTH_SECRET,
    deployIsLocal: input.deployIsLocal ?? true,
  });
}

describe("o deploy que pode ter auto-login de dono", () => {
  it("existe só quando WEB_ORIGIN e BETTER_AUTH_URL são loopback de verdade", () => {
    expect(
      deploymentAllowsLocalSession({
        webOrigin: "http://127.0.0.1:5173",
        authUrl: "http://127.0.0.1:5173",
      }),
    ).toBe(true);
    expect(
      deploymentAllowsLocalSession({
        webOrigin: "http://localhost:5173",
        authUrl: "http://[::1]:5173",
      }),
    ).toBe(true);
    // Instalação de LAN (QUIBT_WEB_BIND_HOST=0.0.0.0): o instalador grava o IP da rede.
    expect(
      deploymentAllowsLocalSession({
        webOrigin: "http://192.168.18.235:5173",
        authUrl: "http://192.168.18.235:5173",
      }),
    ).toBe(false);
    // Instalação pública atrás de TLS de terceiro.
    expect(
      deploymentAllowsLocalSession({
        webOrigin: "https://quibt.example.com",
        authUrl: "https://quibt.example.com",
      }),
    ).toBe(false);
    // Meio a meio não vale: o cookie sai por uma origem que a rede alcança.
    expect(
      deploymentAllowsLocalSession({
        webOrigin: "http://127.0.0.1:5173",
        authUrl: "https://quibt.example.com",
      }),
    ).toBe(false);
  });

  it("trata 127.0.0.0/8 e ::1 como loopback, e nada mais", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.1.2.3")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    // Privado, link-local e CGNAT são a rede de outra pessoa.
    expect(isLoopbackAddress("192.168.1.55")).toBe(false);
    expect(isLoopbackAddress("172.17.0.1")).toBe(false);
    expect(isLoopbackAddress("10.1.2.3")).toBe(false);
    expect(isLoopbackAddress("169.254.10.5")).toBe(false);
    expect(isLoopbackAddress("100.64.3.9")).toBe(false);
    expect(isLoopbackAddress("203.0.113.42")).toBe(false);
  });
});

describe("auto-login de dono: quem chega de fora nunca vira dono", () => {
  it("aceita o navegador desta máquina, direto na API", () => {
    expect(claim({ peerAddress: "127.0.0.1" })).toBe(true);
    expect(claim({ peerAddress: "::1", clientHost: "[::1]:3100" })).toBe(true);
  });

  it("aceita o proxy oficial do web quando o cliente encaminhado é loopback", () => {
    // `pnpm dev` e o Electron com a stack na própria máquina: o vite acrescenta 127.0.0.1.
    expect(claim({ peerAddress: "127.0.0.1", hops: ["127.0.0.1"], proxyProof: PROOF })).toBe(true);
    expect(claim({ peerAddress: "172.20.0.4", hops: ["127.0.0.1"], proxyProof: PROOF })).toBe(true);
  });

  it("recusa aparelho da LAN (192.168.x) mesmo com a prova do proxy oficial", () => {
    expect(claim({ peerAddress: "172.20.0.4", hops: ["192.168.1.55"], proxyProof: PROOF })).toBe(
      false,
    );
    expect(claim({ peerAddress: "127.0.0.1", hops: ["192.168.1.55"], proxyProof: PROOF })).toBe(
      false,
    );
  });

  it("recusa a ponte do docker (172.17.x) e as demais faixas privadas", () => {
    for (const hop of ["172.17.0.1", "10.4.0.9", "169.254.10.5", "100.64.3.9", "203.0.113.42"]) {
      expect(claim({ peerAddress: "172.20.0.4", hops: [hop], proxyProof: PROOF })).toBe(false);
    }
  });

  it("recusa uma cadeia onde alguém antes do proxy oficial anunciou outro cliente", () => {
    // nginx na frente do vite: o salto final é loopback, mas o primeiro é a internet.
    expect(
      claim({ peerAddress: "127.0.0.1", hops: ["203.0.113.42", "127.0.0.1"], proxyProof: PROOF }),
    ).toBe(false);
  });

  it("não deixa `x-forwarded-host` forjado decidir nada", () => {
    // O atacante manda `X-Forwarded-Host: 127.0.0.1`; ele não é lido em lugar nenhum.
    expect(
      requestClaimsLocalBrowser({
        clientHost: "192.168.18.235:5173",
        peerAddress: "172.20.0.4",
        forwardedHops: ["192.168.1.55"],
        proxyProof: PROOF,
        authSecret: AUTH_SECRET,
        deployIsLocal: true,
      }),
    ).toBe(false);
    expect(forwardedHops(undefined)).toEqual([]);
    expect(forwardedHops("203.0.113.42, 127.0.0.1")).toEqual(["203.0.113.42", "127.0.0.1"]);
  });

  it("recusa proxy de terceiro sem XFF quando o deploy não é loopback", () => {
    expect(claim({ peerAddress: "127.0.0.1", deployIsLocal: false })).toBe(false);
    expect(
      claim({
        peerAddress: "127.0.0.1",
        hops: ["127.0.0.1"],
        proxyProof: PROOF,
        deployIsLocal: false,
      }),
    ).toBe(false);
  });

  it("recusa prova ausente, forjada ou de outro domínio de chave", () => {
    expect(claim({ peerAddress: "172.20.0.4", hops: ["127.0.0.1"] })).toBe(false);
    expect(claim({ peerAddress: "172.20.0.4", hops: ["127.0.0.1"], proxyProof: "forged" })).toBe(
      false,
    );
    // A prova assinada com o BETTER_AUTH_SECRET cru (sem rótulo de domínio) não vale.
    const rawKeyProof = createHmac("sha256", AUTH_SECRET)
      .update("quibt-local-browser-proxy-v1")
      .digest("base64url");
    expect(claim({ peerAddress: "172.20.0.4", hops: ["127.0.0.1"], proxyProof: rawKeyProof })).toBe(
      false,
    );
  });

  it("recusa peer público, com ou sem prova", () => {
    expect(claim({ peerAddress: "203.0.113.42" })).toBe(false);
    expect(claim({ peerAddress: "203.0.113.42", hops: ["127.0.0.1"], proxyProof: PROOF })).toBe(
      false,
    );
  });
});

/**
 * A porta de verdade, não só a função de decisão: `POST /api/local/session` cria a sessão
 * do dono sem credencial nenhuma. 404 = a porta não existe para este cliente; 409 = o
 * cliente passou pela porta (e o deploy ainda não tem dono gravado).
 */
describe("POST /api/local/session", () => {
  const deployment = {
    id: "default",
    ownerUserId: null,
    signupsEnabled: false,
    signupAllowlist: "",
  };
  const claimRow = { id: "default", claimedAt: new Date() };
  const prisma = {
    deploymentSettings: {
      upsert: async () => deployment,
      findUnique: async () => deployment,
    },
    deploymentClaim: {
      upsert: async () => claimRow,
      findUnique: async () => claimRow,
    },
    $queryRawUnsafe: async () => 1,
    $disconnect: async () => undefined,
  } as unknown as PrismaClient;

  async function post(
    deploy: { webOrigin: string; authUrl: string },
    headers: Record<string, string>,
    peerAddress: string,
  ) {
    const handles = await createApp({
      prisma,
      databaseUrl: "postgres://test-only.invalid/quibt",
      authSecret: AUTH_SECRET,
      ...deploy,
    });
    try {
      return await (
        handles.app as unknown as {
          request: (
            url: string,
            init: RequestInit,
            env: { incoming: { socket: { remoteAddress: string } } },
          ) => Promise<Response>;
        }
      ).request(
        "http://127.0.0.1:3100/api/local/session",
        { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" },
        { incoming: { socket: { remoteAddress: peerAddress } } },
      );
    } finally {
      await handles.stop();
    }
  }

  const LOCAL = { webOrigin: "http://127.0.0.1:5173", authUrl: "http://127.0.0.1:5173" };
  const LAN = { webOrigin: "http://192.168.18.235:5173", authUrl: "http://192.168.18.235:5173" };

  it("abre para o navegador desta máquina (desktop local, `pnpm dev`)", async () => {
    const direct = await post(LOCAL, { host: "127.0.0.1:3100" }, "127.0.0.1");
    expect(direct.status).toBe(409);
    const throughProxy = await post(
      LOCAL,
      {
        host: "127.0.0.1:3100",
        "x-forwarded-for": "127.0.0.1",
        "x-forwarded-host": "127.0.0.1:5173",
        "x-quibt-internal-proxy": PROOF,
      },
      "127.0.0.1",
    );
    expect(throughProxy.status).toBe(409);
  });

  it("não existe numa instalação de LAN, nem com todos os cabeçalhos forjados", async () => {
    const forged = await post(
      LAN,
      {
        host: "127.0.0.1:5173",
        "x-forwarded-host": "127.0.0.1",
        "x-forwarded-for": "192.168.1.55",
        "x-quibt-internal-proxy": PROOF,
      },
      "172.20.0.4",
    );
    expect(forged.status).toBe(404);
  });

  it("recusa o vizinho do Wi-Fi mesmo num deploy loopback", async () => {
    const lanDevice = await post(
      LOCAL,
      {
        host: "127.0.0.1:5173",
        "x-forwarded-host": "127.0.0.1",
        "x-forwarded-for": "192.168.1.55",
        "x-quibt-internal-proxy": PROOF,
      },
      "172.20.0.4",
    );
    expect(lanDevice.status).toBe(404);
  });

  it("recusa proxy de terceiro que não anuncia o cliente", async () => {
    // nginx público na frente de uma instalação com domínio: sem XFF, e o `Host` é dele.
    const thirdParty = await post(
      { webOrigin: "https://quibt.example.com", authUrl: "https://quibt.example.com" },
      { host: "127.0.0.1:5173", "x-forwarded-host": "127.0.0.1" },
      "127.0.0.1",
    );
    expect(thirdParty.status).toBe(404);
  });
});

/**
 * O caminho separado e explícito: o app do desktop administra a stack e lê o `quibt.env`,
 * então ele prova POSSE DO SEGREDO LOCAL em vez de posição de rede. Isso é necessário
 * porque, com a stack em Docker, o dono e o vizinho do Wi-Fi chegam com o MESMO endereço
 * de origem (`172.17.0.1`): a API publica a 3100 em 0.0.0.0 de propósito, para o QR do
 * celular. Quem tem o segredo já poderia forjar o cookie assinado de sessão — a capacidade
 * não entrega poder novo, só evita que o dono fique de fora.
 */
function capabilityFor(overrides: { issuedAt?: number; nonce?: string; path?: string } = {}) {
  return signDesktopSessionCapability({
    authSecret: AUTH_SECRET,
    method: "POST",
    path: overrides.path ?? "/api/local/session",
    issuedAt: overrides.issuedAt ?? Date.now(),
    nonce: overrides.nonce ?? "nonce-do-desktop-1",
  });
}

describe("capacidade do desktop (posse do segredo local)", () => {
  it("vale uma vez só", () => {
    const used = new Map<string, number>();
    const capability = capabilityFor();
    const check = { authSecret: AUTH_SECRET, method: "POST", path: "/api/local/session", used };
    expect(consumeDesktopSessionCapability(capability, check)).toBe(true);
    // Replay: o mesmo cabeçalho, lido do disco do container, não entra de novo.
    expect(consumeDesktopSessionCapability(capability, check)).toBe(false);
  });

  it("expira e não aceita relógio adiantado", () => {
    const now = Date.now();
    const check = {
      authSecret: AUTH_SECRET,
      method: "POST",
      path: "/api/local/session",
      used: new Map<string, number>(),
      now,
    };
    expect(
      consumeDesktopSessionCapability(
        capabilityFor({ issuedAt: now - DESKTOP_CAPABILITY_TTL_MS - 1 }),
        check,
      ),
    ).toBe(false);
    expect(consumeDesktopSessionCapability(capabilityFor({ issuedAt: now + 60_000 }), check)).toBe(
      false,
    );
    expect(consumeDesktopSessionCapability(capabilityFor({ issuedAt: now - 1_000 }), check)).toBe(
      true,
    );
  });

  it("está presa ao método e ao caminho da requisição", () => {
    const used = new Map<string, number>();
    expect(
      consumeDesktopSessionCapability(capabilityFor({ path: "/api/local/reset-link" }), {
        authSecret: AUTH_SECRET,
        method: "POST",
        path: "/api/local/session",
        used,
      }),
    ).toBe(false);
    expect(
      consumeDesktopSessionCapability(capabilityFor(), {
        authSecret: AUTH_SECRET,
        method: "GET",
        path: "/api/local/session",
        used,
      }),
    ).toBe(false);
  });

  it("recusa lixo, prova forjada e chave de outro domínio", () => {
    const check = {
      authSecret: AUTH_SECRET,
      method: "POST",
      path: "/api/local/session",
      used: new Map<string, number>(),
    };
    expect(consumeDesktopSessionCapability(undefined, check)).toBe(false);
    expect(consumeDesktopSessionCapability("", check)).toBe(false);
    expect(consumeDesktopSessionCapability("v1.abc.def.ghi", check)).toBe(false);
    expect(
      consumeDesktopSessionCapability(
        signDesktopSessionCapability({
          authSecret: "outro-segredo-de-32-caracteres-aqui", // gitleaks:allow -- test-only key
          method: "POST",
          path: "/api/local/session",
          issuedAt: Date.now(),
          nonce: "n1",
        }),
        check,
      ),
    ).toBe(false);
    // A mesma mensagem assinada com a chave do proxy interno não vale aqui.
    expect(consumeDesktopSessionCapability(`v1.${Date.now()}.n2.${PROOF}`, check)).toBe(false);
  });
});

/**
 * A porta, no formato em que o produto empacotado realmente roda: stack em Docker, a API
 * publicada em 0.0.0.0:3100 (é assim que o QR do celular funciona) e o dono chegando com o
 * mesmo `172.17.0.1` do vizinho de Wi-Fi. Só a capacidade separa os dois.
 */
describe("POST /api/local/session com a stack em Docker", () => {
  const deployment = {
    id: "default",
    ownerUserId: null,
    signupsEnabled: false,
    signupAllowlist: "",
  };
  const claimRow = { id: "default", claimedAt: new Date() };
  const prisma = {
    deploymentSettings: {
      upsert: async () => deployment,
      findUnique: async () => deployment,
    },
    deploymentClaim: {
      upsert: async () => claimRow,
      findUnique: async () => claimRow,
    },
    $queryRawUnsafe: async () => 1,
    $disconnect: async () => undefined,
  } as unknown as PrismaClient;

  async function withApp(
    run: (
      post: (headers: Record<string, string>, peerAddress: string) => Promise<Response>,
    ) => Promise<void>,
  ) {
    const handles = await createApp({
      prisma,
      databaseUrl: "postgres://test-only.invalid/quibt",
      authSecret: AUTH_SECRET,
      webOrigin: "http://127.0.0.1:5173",
      authUrl: "http://127.0.0.1:5173",
    });
    const post = (headers: Record<string, string>, peerAddress: string) =>
      (
        handles.app as unknown as {
          request: (
            url: string,
            init: RequestInit,
            env: { incoming: { socket: { remoteAddress: string } } },
          ) => Promise<Response>;
        }
      ).request(
        "http://127.0.0.1:3100/api/local/session",
        { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" },
        { incoming: { socket: { remoteAddress: peerAddress } } },
      );
    try {
      await run(post);
    } finally {
      await handles.stop();
    }
  }

  it("o Electron empacotado entra com a capacidade, pelo proxy do web e direto na 3100", async () => {
    await withApp(async (post) => {
      const throughWeb = await post(
        {
          host: "api:3100",
          "x-forwarded-for": "172.17.0.1",
          "x-forwarded-host": "127.0.0.1:5173",
          "x-quibt-internal-proxy": PROOF,
          [DESKTOP_CAPABILITY_HEADER]: capabilityFor({ nonce: "desktop-web" }),
        },
        "172.20.0.4",
      );
      expect(throughWeb.status).toBe(409);
      const direct = await post(
        {
          host: "127.0.0.1:3100",
          [DESKTOP_CAPABILITY_HEADER]: capabilityFor({ nonce: "desktop-direto" }),
        },
        "172.17.0.1",
      );
      expect(direct.status).toBe(409);
    });
  });

  it("o vizinho do Wi-Fi na mesma 3100, com o mesmo 172.17.0.1 e sem capacidade, é recusado", async () => {
    await withApp(async (post) => {
      const attacker = await post(
        { host: "127.0.0.1:3100", "x-forwarded-host": "127.0.0.1" },
        "172.17.0.1",
      );
      expect(attacker.status).toBe(404);
      const withProxyHeaders = await post(
        {
          host: "127.0.0.1:5173",
          "x-forwarded-for": "172.17.0.1",
          "x-quibt-internal-proxy": PROOF,
        },
        "172.20.0.4",
      );
      expect(withProxyHeaders.status).toBe(404);
    });
  });

  it("capacidade replayada, expirada ou forjada não entra", async () => {
    await withApp(async (post) => {
      const capability = capabilityFor({ nonce: "usada-uma-vez" });
      const first = await post(
        { host: "127.0.0.1:3100", [DESKTOP_CAPABILITY_HEADER]: capability },
        "172.17.0.1",
      );
      expect(first.status).toBe(409);
      const replay = await post(
        { host: "127.0.0.1:3100", [DESKTOP_CAPABILITY_HEADER]: capability },
        "172.17.0.1",
      );
      expect(replay.status).toBe(404);
      const expired = await post(
        {
          host: "127.0.0.1:3100",
          [DESKTOP_CAPABILITY_HEADER]: capabilityFor({
            nonce: "velha",
            issuedAt: Date.now() - DESKTOP_CAPABILITY_TTL_MS - 1_000,
          }),
        },
        "172.17.0.1",
      );
      expect(expired.status).toBe(404);
      const forged = await post(
        { host: "127.0.0.1:3100", [DESKTOP_CAPABILITY_HEADER]: `v1.${Date.now()}.n.${PROOF}` },
        "172.17.0.1",
      );
      expect(forged.status).toBe(404);
    });
  });
});
