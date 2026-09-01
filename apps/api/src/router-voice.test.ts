import { call } from "@orpc/server";
import type { Actor } from "@quibt/contracts";
import type { PrismaClient } from "@quibt/db";
import { describe, expect, it, vi } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

const actor: Actor = {
  userId: "user-1",
  workspaceId: "ws-1",
  workspaceRole: "owner",
  email: "owner@example.com",
  isDeploymentOwner: true,
};

const context = { actor };

function harness(options: { provider?: string; agentRuntime?: string } = {}) {
  const findFirst = vi.fn(async () =>
    options.provider
      ? {
          id: "credential-1",
          userId: actor.userId,
          workspaceId: actor.workspaceId,
          provider: options.provider,
          updatedAt: new Date(),
        }
      : null,
  );
  const prisma = { userModelCredential: { findFirst } } as unknown as PrismaClient;
  const deps = {
    prisma,
    env: {
      defaultProvider: "openrouter",
      defaultModel: "model",
      screenProxySecret: "secret",
      sandboxProvider: "docker",
      agentRuntime: options.agentRuntime ?? "pi",
    },
  } as unknown as RouterDeps;
  return { router: createRouter(deps), findFirst };
}

describe("voice status", () => {
  it("is ready only from the existing openai-codex model credential", async () => {
    const { router, findFirst } = harness({ provider: "openai-codex" });

    await expect(call(router.voice.status, undefined, { context })).resolves.toEqual({
      configured: true,
      provider: "openai-codex",
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        userId: actor.userId,
        workspaceId: actor.workspaceId,
        provider: "openai-codex",
      },
      orderBy: { updatedAt: "desc" },
    });
  });

  it("reports voice unavailable without a ChatGPT/Codex login", async () => {
    const { router } = harness();
    await expect(call(router.voice.status, undefined, { context })).resolves.toEqual({
      configured: false,
      provider: null,
    });
  });

  it("keeps scripted tests offline and ready without creating another credential", async () => {
    const { router, findFirst } = harness({ agentRuntime: "scripted" });
    await expect(call(router.voice.status, undefined, { context })).resolves.toEqual({
      configured: true,
      provider: "openai-codex",
    });
    expect(findFirst).not.toHaveBeenCalled();
  });
});
