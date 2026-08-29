import type { SandboxProvider, WakeupDriver, WakeupJob } from "@quibt/adapter-kit";
import type { PrismaClient } from "@quibt/db";
import { describe, expect, it, vi } from "vitest";
import {
  CONTROL_SCREEN_REVOKE_JOB,
  revokeControlScreen,
  revokeControlScreenOrSchedule,
} from "./control-screen-revocation.js";

function harness(kind = "docker") {
  const updates: unknown[] = [];
  const jobs: WakeupJob[] = [];
  const revokeScreen = vi.fn(async () => undefined);
  const prisma = {
    desktopSession: {
      findUnique: vi.fn(async () => ({
        botId: "bot-1",
        workspaceId: "ws-1",
        display: 2,
        providerRef: "container-1",
        computer: { kind, providerRef: "container-1" },
      })),
      updateMany: vi.fn(async (args: unknown) => {
        updates.push(args);
        return { count: 1 };
      }),
    },
  } as unknown as PrismaClient;
  const sandbox = { revokeScreen } as unknown as SandboxProvider;
  const wakeup = {
    enqueue: vi.fn(async (job: WakeupJob) => {
      jobs.push(job);
    }),
  } as unknown as WakeupDriver;
  return { prisma, sandbox, wakeup, revokeScreen, updates, jobs };
}

describe("control screen revocation", () => {
  it("rotates one Docker display and clears its cached URL", async () => {
    const state = harness();
    await expect(revokeControlScreen(state, "bot-1")).resolves.toBe("revoked");
    expect(state.revokeScreen).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "bot-1", display: 2, providerRef: "container-1" }),
      expect.objectContaining({ workspaceId: "ws-1", userId: "system" }),
    );
    expect(state.updates).toEqual([{ where: { botId: "bot-1" }, data: { screenUrl: null } }]);
  });

  it("does not rotate managed-provider screens", async () => {
    const state = harness("e2b");
    await expect(revokeControlScreen(state, "bot-1")).resolves.toBe("skipped");
    expect(state.revokeScreen).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it("retries a failed Docker rotation without failing the lease release", async () => {
    const state = harness();
    state.revokeScreen.mockRejectedValueOnce(new Error("docker unavailable"));
    await expect(revokeControlScreenOrSchedule(state, "bot-1")).resolves.toBe(false);
    expect(state.jobs).toEqual([
      expect.objectContaining({
        name: CONTROL_SCREEN_REVOKE_JOB,
        payload: { botId: "bot-1", attempt: 1 },
        jobKey: `${CONTROL_SCREEN_REVOKE_JOB}:bot-1`,
      }),
    ]);
  });
});
