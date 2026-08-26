import type { PrismaClient } from "@quibt/db";
import { describe, expect, it } from "vitest";
import {
  createApp,
  deploymentSignupDenial,
  internalProxyProof,
  loopbackClientHost,
  requestClaimsLocalBrowser,
} from "./app.js";

const TEST_DATABASE_URL = "postgres://test-only.invalid/quibt";

/**
 * The deployment screen writes `signupsEnabled` and `signupAllowlist`, but better-auth reads
 * SIGNUPS_ENABLED / SIGNUP_ALLOWLIST once at boot. These tests drive the real Hono app to prove
 * the saved settings are actually in force on the sign-up route.
 */
function appWith(settings: { signupsEnabled: boolean; signupAllowlist: string }) {
  const deployment = {
    id: "default",
    ownerUserId: "existing-owner",
    signupsEnabled: settings.signupsEnabled,
    signupAllowlist: settings.signupAllowlist,
  };
  const claim = { id: "default", claimedAt: new Date() };
  const prisma = {
    deploymentSettings: {
      upsert: async () => deployment,
      findUnique: async () => deployment,
    },
    deploymentClaim: {
      upsert: async () => claim,
      findUnique: async () => claim,
    },
    $queryRawUnsafe: async () => 1,
    $disconnect: async () => undefined,
  } as unknown as PrismaClient;
  return createApp({ prisma, databaseUrl: TEST_DATABASE_URL });
}

async function signUp(app: { request: (...args: never[]) => Promise<Response> }, email: string) {
  return (
    app as unknown as {
      request: (url: string, init: RequestInit) => Promise<Response>;
    }
  ).request("http://localhost/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      password: "senha-bem-comprida",
      name: "New",
    }),
  });
}

describe("the deployment signup switch", () => {
  it("refuses new accounts once the owner closes signups", async () => {
    const handles = await appWith({
      signupsEnabled: false,
      signupAllowlist: "",
    });
    const res = await signUp(handles.app, "new@example.com");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      message: "Este deploy não está aceitando novas contas.",
    });
    await handles.stop();
  });

  it("applies the saved allowlist and lets an allowed address through the gate", async () => {
    const handles = await appWith({
      signupsEnabled: true,
      signupAllowlist: "@quibt.com.br",
    });
    const blocked = await signUp(handles.app, "stranger@example.com");
    expect(blocked.status).toBe(403);
    // The allowed address is not stopped here; whatever happens next is better-auth's business.
    const allowed = await signUp(handles.app, "someone@quibt.com.br");
    expect(allowed.status).not.toBe(403);
    await handles.stop();
  });

  it("refuses sign-up when the settings read fails instead of opening the door", async () => {
    const claim = { id: "default", claimedAt: new Date() };
    const prisma = {
      deploymentSettings: {
        upsert: async () => ({
          id: "default",
          ownerUserId: "existing-owner",
          signupsEnabled: true,
          signupAllowlist: "",
        }),
        findUnique: async () => {
          throw new Error("connection lost");
        },
      },
      deploymentClaim: {
        upsert: async () => claim,
        findUnique: async () => claim,
      },
      $queryRawUnsafe: async () => 1,
      $disconnect: async () => undefined,
    } as unknown as PrismaClient;
    const handles = await createApp({ prisma, databaseUrl: TEST_DATABASE_URL });
    const res = await signUp(handles.app, "new@example.com");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      message: "Não foi possível verificar se este deploy aceita novas contas.",
    });
    await handles.stop();
  });
});

describe("o cadastro nasce fechado", () => {
  /** Um deploy recém-instalado: linha padrão (fechada), sem dono, sem convite consumido. */
  function freshDeploy(overrides: Partial<{ signupsEnabled: string }> = {}) {
    const upserts: Array<{ create: Record<string, unknown>; update: Record<string, unknown> }> = [];
    const deployment = {
      id: "default",
      ownerUserId: null,
      signupsEnabled: false,
      signupAllowlist: "",
    };
    const claim = { id: "default", claimedAt: null };
    const prisma = {
      deploymentSettings: {
        upsert: async (args: (typeof upserts)[number]) => {
          upserts.push(args);
          return deployment;
        },
        findUnique: async () => deployment,
      },
      deploymentClaim: {
        upsert: async () => claim,
        findUnique: async () => claim,
      },
      bootstrapInvite: { findUnique: async () => null },
      $queryRawUnsafe: async () => 1,
      $disconnect: async () => undefined,
    } as unknown as PrismaClient;
    return {
      upserts,
      handles: createApp({ prisma, databaseUrl: TEST_DATABASE_URL, ...overrides }),
    };
  }

  it("o interruptor fechado não barra o primeiro dono: a porta dele é o código do instalador", async () => {
    const { handles } = freshDeploy();
    const app = await handles;
    const res = await signUp(app.app, "dono@example.com");
    // 403 continua — mas pelo convite que faltou, não por "não aceita novas contas".
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      message: "Este deploy exige um convite de proprietário.",
    });
    await app.stop();
  });

  it("depois do dono, o mesmo interruptor fechado vale para todo mundo", () => {
    const settings = { signupsEnabled: false, signupAllowlist: "" };
    expect(deploymentSignupDenial(settings, "x@example.com", { firstOwner: true })).toBeNull();
    expect(deploymentSignupDenial(settings, "x@example.com", { firstOwner: false })).toBe(
      "Este deploy não está aceitando novas contas.",
    );
    expect(deploymentSignupDenial(settings, "x@example.com")).toBe(
      "Este deploy não está aceitando novas contas.",
    );
  });

  it("SIGNUPS_ENABLED no .env manda no interruptor salvo a cada subida; sem ele, o salvo fica", async () => {
    const open = freshDeploy({ signupsEnabled: "true" });
    await (await open.handles).stop();
    expect(open.upserts[0]).toMatchObject({
      create: { id: "default", signupsEnabled: true },
      update: { signupsEnabled: true },
    });

    const closed = freshDeploy({ signupsEnabled: "false" });
    await (await closed.handles).stop();
    expect(closed.upserts[0]).toMatchObject({
      create: { id: "default", signupsEnabled: false },
      update: { signupsEnabled: false },
    });

    const unset = freshDeploy({ signupsEnabled: undefined });
    await (await unset.handles).stop();
    expect(unset.upserts[0]?.create).toEqual({ id: "default" });
    expect(unset.upserts[0]?.update).toEqual({});
  });
});

describe("primeira conta sem convite", () => {
  it("só vale quando o cliente chegou pela própria máquina", () => {
    // Loopback é o endereço que ninguém alcança de fora: equivale a estar no teclado.
    expect(loopbackClientHost("127.0.0.1:5173")).toBe(true);
    expect(loopbackClientHost("localhost")).toBe(true);
    expect(loopbackClientHost("[::1]:3100")).toBe(true);
    // Um endereço público (VPS) continua exigindo o código do instalador.
    expect(loopbackClientHost("quibt.example.com")).toBe(false);
    expect(loopbackClientHost("192.168.1.20:5173")).toBe(false);
    expect(loopbackClientHost("")).toBe(false);
    expect(loopbackClientHost(undefined)).toBe(false);
  });

  it("não confia em Host ou X-Forwarded-Host enviados por um cliente remoto", () => {
    const authSecret = "test-auth-secret-32-characters-long";
    for (const clientHost of ["localhost", "127.0.0.1:5173"]) {
      expect(
        requestClaimsLocalBrowser({
          clientHost,
          peerAddress: "203.0.113.42",
          forwardedClientIp: undefined,
          proxyProof: undefined,
          authSecret,
        }),
      ).toBe(false);
    }
  });

  it("aceita localhost direto e exige prova mais IP local atrás do proxy", () => {
    const authSecret = "test-auth-secret-32-characters-long";
    expect(
      requestClaimsLocalBrowser({
        clientHost: "localhost:5173",
        peerAddress: "127.0.0.1",
        forwardedClientIp: undefined,
        proxyProof: undefined,
        authSecret,
      }),
    ).toBe(true);
    expect(
      requestClaimsLocalBrowser({
        clientHost: "localhost:5173",
        peerAddress: "172.20.0.4",
        forwardedClientIp: "127.0.0.1",
        proxyProof: internalProxyProof(authSecret),
        authSecret,
      }),
    ).toBe(true);
    // A private LAN address is not physical-presence proof by itself. The official proxy is
    // loopback-bound; deployments exposing it to a LAN do not gain local privileges.
    expect(
      requestClaimsLocalBrowser({
        clientHost: "localhost:5173",
        peerAddress: "172.20.0.4",
        forwardedClientIp: "203.0.113.42",
        proxyProof: internalProxyProof(authSecret),
        authSecret,
      }),
    ).toBe(false);
    expect(
      requestClaimsLocalBrowser({
        clientHost: "localhost:5173",
        peerAddress: "172.20.0.4",
        forwardedClientIp: "127.0.0.1",
        proxyProof: "forged",
        authSecret,
      }),
    ).toBe(false);
  });
});
