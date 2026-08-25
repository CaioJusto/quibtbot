import type { PrismaClient } from "@quibt/db";
import { describe, expect, it, vi } from "vitest";
import { onControlLeaseGranted } from "./control-lease-lifecycle.js";

describe("onControlLeaseGranted", () => {
  it("clears lifecycle token and cancels pending stop intents", async () => {
    const desktopUpdateMany = vi.fn(async () => ({ count: 1 }));
    const orphanUpdateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      desktopSession: {
        findUnique: vi.fn(async () => ({
          botId: "bot-a",
          workspaceId: "ws-1",
          providerRef: "container-1",
          computer: { kind: "docker" },
        })),
        updateMany: desktopUpdateMany,
      },
      orphanProvision: { updateMany: orphanUpdateMany },
    } as unknown as PrismaClient;

    await onControlLeaseGranted(prisma, { botId: "bot-a" });

    expect(desktopUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ botId: "bot-a" }),
        data: expect.objectContaining({ bootClaimToken: null, bootClaimedAt: null }),
      }),
    );
    expect(orphanUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sessionBotId: "bot-a",
          lifecycleAction: "stop:idle",
          status: "pending",
        }),
        data: expect.objectContaining({ status: "cancelled" }),
      }),
    );
  });
});
