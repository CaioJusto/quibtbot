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

interface Settings {
  sandboxProvider: string | null;
  sandboxEndpoint?: string | null;
  sandboxCredentialCipher?: string | null;
}

function harness(
  env: Partial<RouterDeps["env"]> = {},
  settings: Settings = { sandboxProvider: null },
) {
  const saved: Array<Record<string, unknown>> = [];
  const invalidated: number[] = [];
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
        signupsEnabled: true,
        signupAllowlist: "",
        defaultModelProvider: null,
        defaultModelId: null,
        deploymentModelCredentialCipher: null,
        sandboxEndpoint: null,
        sandboxCredentialCipher: null,
        ...settings,
      }),
      upsert: async (args: { update: Record<string, unknown> }) => {
        saved.push(args.update);
        if (typeof args.update.sandboxProvider === "string") {
          settings.sandboxProvider = args.update.sandboxProvider;
        }
        if (typeof args.update.sandboxEndpoint === "string") {
          settings.sandboxEndpoint = args.update.sandboxEndpoint;
        }
        if (typeof args.update.sandboxCredentialCipher === "string") {
          settings.sandboxCredentialCipher = args.update.sandboxCredentialCipher;
        }
        return {};
      },
    },
    deploymentClaim: {
      findUnique: async () => ({ claimedAt: new Date() }),
    },
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    secrets: {
      put: async (plaintext: string) => ({ id: "s", ciphertext: `enc:${plaintext}` }),
      load: (ciphertext: string) => ciphertext.replace(/^enc:/, ""),
    },
    onDeploymentSettingsChanged: () => invalidated.push(1),
    env: {
      defaultProvider: "openrouter",
      defaultModel: "model",
      screenProxySecret: "secret",
      sandboxProvider: "docker",
      availableMachines: ["docker", "e2b"],
      ...env,
    },
  } as unknown as RouterDeps;
  return { router: createRouter(deps), saved, invalidated };
}

const context = { actor };

describe("edition gating", () => {
  it("keeps health, me, and the picker on one answer for an unpaid self-host deploy", async () => {
    const { router } = harness({ release: "0.2.18" });
    const health = await call(router.health, undefined, { context });
    const me = await call(router.me, undefined, { context });
    expect(health.edition).toBe("oss");
    expect(health.canChooseMachine).toBe(true);
    expect(health.version).toBe("0.2.18");
    expect(me.edition).toBe("oss");
    expect(me.canChooseMachine).toBe(true);
  });

  it("fails closed when a billing deploy forgot QUIBT_EDITION", async () => {
    const { router } = harness({ billingEnabled: true, sandboxProvider: "e2b" });
    const health = await call(router.health, undefined, { context });
    const me = await call(router.me, undefined, { context });
    expect(health.edition).toBe("cloud");
    expect(health.canChooseMachine).toBe(false);
    // The bug: me said "oss" and handed the picker to a paying Cloud deploy.
    expect(me.edition).toBe("cloud");
    expect(me.canChooseMachine).toBe(false);
    await expect(
      call(router.deployment.update, { sandboxProvider: "docker" }, { context }),
    ).rejects.toBeInstanceOf(ORPCError);
  });
});

describe("the machine the deploy reports", () => {
  it("reports the saved choice in both places once it is saved", async () => {
    const { router, invalidated } = harness({}, { sandboxProvider: null });
    expect((await call(router.me, undefined, { context })).sandboxProvider).toBe("docker");
    expect((await call(router.health, undefined, { context })).sandbox).toBe("docker");
    const updated = await call(router.deployment.update, { sandboxProvider: "e2b" }, { context });
    expect(updated.sandboxProvider).toBe("e2b");
    expect(invalidated).toHaveLength(1);
    expect((await call(router.me, undefined, { context })).sandboxProvider).toBe("e2b");
    expect((await call(router.health, undefined, { context })).sandbox).toBe("e2b");
  });

  it("never reports a saved machine the edition or the deploy cannot honor", async () => {
    const cloud = harness(
      { billingEnabled: true, edition: "cloud", sandboxProvider: "e2b" },
      { sandboxProvider: "docker" },
    );
    expect((await call(cloud.router.me, undefined, { context })).sandboxProvider).toBe("e2b");
    expect((await call(cloud.router.deployment.get, undefined, { context })).sandboxProvider).toBe(
      "e2b",
    );

    const keyGone = harness({ availableMachines: ["docker"] }, { sandboxProvider: "e2b" });
    expect((await call(keyGone.router.me, undefined, { context })).sandboxProvider).toBe("docker");
  });

  it("lets the owner pick a cloud sandbox with a pasted key, and refuses without one", async () => {
    const { router } = harness({ availableMachines: ["docker"] });
    await expect(
      call(router.computers.activate, { kind: "e2b" }, { context }),
    ).rejects.toBeInstanceOf(ORPCError);
    const e2b = await call(
      router.computers.activate,
      { kind: "e2b", apiKey: "e2b_x" },
      { context },
    );
    expect(e2b.sandboxProvider).toBe("e2b");
    const box = await call(
      router.computers.activate,
      { kind: "box", apiKey: "box_x" },
      { context },
    );
    expect(box.sandboxProvider).toBe("box");
    const daytona = await call(
      router.computers.activate,
      { kind: "daytona", apiKey: "daytona_x" },
      { context },
    );
    expect(daytona.sandboxProvider).toBe("daytona");
  });

  it("reuses the saved machine key when the owner tests the configured Box again", async () => {
    const { router } = harness(
      { availableMachines: ["docker"] },
      { sandboxProvider: "box", sandboxCredentialCipher: "enc:box_saved" },
    );
    await expect(call(router.computers.probe, { kind: "box" }, { context })).resolves.toEqual({
      ok: true,
      message: "Chave presente. O próximo computador sobe no Box.",
    });
  });

  it("reuses the saved machine key when the owner tests the configured Daytona again", async () => {
    const { router } = harness(
      { availableMachines: ["docker"] },
      { sandboxProvider: "daytona", sandboxCredentialCipher: "enc:daytona_saved" },
    );
    await expect(call(router.computers.probe, { kind: "daytona" }, { context })).resolves.toEqual({
      ok: true,
      message: "Chave presente. O próximo computador sobe na Daytona.",
    });
  });

  it("lets the owner pick a VPS when URL and token are present", async () => {
    const { router } = harness({ availableMachines: ["docker"] });
    await expect(
      call(router.computers.activate, { kind: "remote-supervisor" }, { context }),
    ).rejects.toBeInstanceOf(ORPCError);
    const vps = await call(
      router.computers.activate,
      { kind: "vps-hetzner", endpoint: "https://vps:7091", apiKey: "tok" },
      { context },
    );
    expect(vps.sandboxProvider).toBe("remote-supervisor");
  });
});
