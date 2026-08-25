import { call } from "@orpc/server";
import type { Actor } from "@quibt/contracts";
import { WORKER_ALIVE_MS } from "@quibt/core";
import type { PrismaClient } from "@quibt/db";
import { describe, expect, it } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";
import type { WorkerPresenceReader } from "./worker-presence.js";

const actor: Actor = {
  userId: "user-1",
  workspaceId: "ws-1",
  workspaceRole: "owner",
  email: "owner@example.com",
  isDeploymentOwner: true,
};
const context = { actor };
const now = new Date("2026-08-25T12:00:00.000Z");

function harness(input: { heartbeatSeenAt?: Date | null; workerPresence?: WorkerPresenceReader }) {
  const prisma = {
    user: {
      findUniqueOrThrow: async () => ({
        id: "user-1",
        email: "owner@example.com",
        name: "Owner",
        emailVerified: true,
      }),
    },
    userModelCredential: { findFirst: async () => null },
    deploymentSettings: {
      findUnique: async () => ({
        ownerUserId: "user-1",
        signupsEnabled: false,
        signupAllowlist: "",
        sandboxProvider: null,
        sandboxEndpoint: null,
        sandboxCredentialCipher: null,
      }),
    },
    deploymentClaim: { findUnique: async () => ({ claimedAt: new Date() }) },
    workerHeartbeat: {
      findFirst: async () =>
        input.heartbeatSeenAt === undefined || input.heartbeatSeenAt === null
          ? null
          : { seenAt: input.heartbeatSeenAt },
    },
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    workerPresence: input.workerPresence,
    env: {
      defaultProvider: "openrouter",
      defaultModel: "model",
      screenProxySecret: "secret",
      sandboxProvider: "docker",
    },
  } as unknown as RouterDeps;
  return createRouter(deps);
}

describe("o worker em health e em me", () => {
  it("sem batimento nenhum, os dois dizem que o worker não está rodando", async () => {
    const router = harness({ heartbeatSeenAt: null });
    const health = await call(router.health, undefined, { context });
    const me = await call(router.me, undefined, { context });
    expect(health.worker).toEqual({ alive: false, lastSeenAt: null });
    expect(me.worker).toEqual({ alive: false, lastSeenAt: null });
  });

  it("um batimento recente é worker vivo, com a hora em que foi visto", async () => {
    const seen = new Date(Date.now() - 10_000);
    const router = harness({ heartbeatSeenAt: seen });
    const health = await call(router.health, undefined, { context });
    const me = await call(router.me, undefined, { context });
    expect(health.worker).toEqual({ alive: true, lastSeenAt: seen.toISOString() });
    expect(me.worker).toEqual({ alive: true, lastSeenAt: seen.toISOString() });
  });

  it("um batimento velho é worker morto, mas a hora continua lá para quem for olhar", async () => {
    const seen = new Date(Date.now() - WORKER_ALIVE_MS - 5_000);
    const router = harness({ heartbeatSeenAt: seen });
    const me = await call(router.me, undefined, { context });
    expect(me.worker).toEqual({ alive: false, lastSeenAt: seen.toISOString() });
  });

  it("quem injeta o leitor (a API com o wakeup em memória) manda", async () => {
    const router = harness({
      heartbeatSeenAt: null,
      workerPresence: {
        seenAt: async () => now,
        read: async () => ({ alive: true, lastSeenAt: now.toISOString() }),
      },
    });
    const health = await call(router.health, undefined, { context });
    expect(health.worker).toEqual({ alive: true, lastSeenAt: now.toISOString() });
  });
});
