import { call } from "@orpc/server";
import { ComposioUnknownOutcomeError } from "@quibt/adapters";
import type { Actor } from "@quibt/contracts";
import type { PrismaClient } from "@quibt/db";
import { describe, expect, it } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

const owner: Actor = {
  userId: "user-1",
  workspaceId: "ws-1",
  workspaceRole: "owner",
  email: "owner@example.com",
  isDeploymentOwner: true,
};

/**
 * Router com um Composio de mentira que sempre falha de um jeito escolhido, e um Prisma
 * que só anota o que a linha da conexão virou.
 */
function harness(fail: unknown) {
  const updates: { status: string }[] = [];
  const prisma = {
    connection: {
      create: async () => ({ id: "conn-1" }),
      update: async ({ data }: { data: { status: string } }) => {
        updates.push({ status: data.status });
        return { id: "conn-1" };
      },
      delete: async () => ({ id: "conn-1" }),
    },
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    composio: {
      available: async () => true,
      begin: async () => {
        throw fail;
      },
    },
    env: {
      webOrigin: "https://app.example",
      sandboxProvider: "docker",
    },
  } as unknown as RouterDeps;
  return { router: createRouter(deps), updates };
}

describe("connections.begin quando o Composio não confirma", () => {
  it("resultado desconhecido não marca 'error': a conexão pode existir lá", async () => {
    const { router, updates } = harness(new ComposioUnknownOutcomeError("conexão"));
    await expect(
      call(
        router.connections.begin,
        { provider: "gmail", displayName: "Gmail" },
        { context: { actor: owner } },
      ),
    ).rejects.toThrow();
    // "pending" é o estado que deixa o callback e o `complete` reconciliarem sozinhos.
    expect(updates).toEqual([{ status: "pending" }]);
  });

  it("falha de verdade continua sendo 'error'", async () => {
    const { router, updates } = harness(new Error("400 provedor desconhecido"));
    await expect(
      call(
        router.connections.begin,
        { provider: "gmail", displayName: "Gmail" },
        { context: { actor: owner } },
      ),
    ).rejects.toThrow();
    expect(updates).toEqual([{ status: "error" }]);
  });
});
