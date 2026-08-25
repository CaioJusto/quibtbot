import { describe, expect, it, vi } from "vitest";
import {
  isPerBotSandbox,
  isWorkspaceScopedSandbox,
  providerRefsFor,
  sharedComputerSiblingActivity,
  shouldStopSharedComputer,
  workspaceProviderRef,
} from "./workspace-computer.js";

describe("workspace-scoped computers", () => {
  it.each(["docker", "remote-supervisor"])("%s is workspace-scoped", (kind) => {
    expect(isWorkspaceScopedSandbox(kind)).toBe(true);
    expect(isPerBotSandbox(kind)).toBe(false);
  });

  it.each(["e2b", "box"])("%s is per-bot", (kind) => {
    expect(isWorkspaceScopedSandbox(kind)).toBe(false);
    expect(isPerBotSandbox(kind)).toBe(true);
  });

  it("treats unknown providers as per-bot for safety", () => {
    expect(isWorkspaceScopedSandbox("fake")).toBe(false);
    expect(isPerBotSandbox("fake")).toBe(true);
    expect(isPerBotSandbox(null)).toBe(true);
    expect(isPerBotSandbox(undefined)).toBe(true);
  });

  it("ignores a legacy computer ref for Box", () => {
    expect(
      workspaceProviderRef({
        providerRef: "box-for-this-bot",
        computer: { kind: "box", providerRef: "legacy-shared-box" },
      }),
    ).toBe("box-for-this-bot");
  });

  it("reads the workspace providerRef for docker", () => {
    expect(
      workspaceProviderRef({
        providerRef: "session-ref",
        computer: { kind: "docker", providerRef: "ws-docker" },
      }),
    ).toBe("ws-docker");
    expect(
      workspaceProviderRef({
        providerRef: "session-e2b",
        computer: { kind: "e2b", providerRef: "ws-ignored" },
      }),
    ).toBe("session-e2b");
  });

  it.each(["docker", "remote-supervisor"])("providerRefsFor sets both refs for %s", (kind) => {
    expect(providerRefsFor(kind, "container-workspace")).toEqual({
      computerProviderRef: "container-workspace",
      desktopProviderRef: "container-workspace",
    });
  });

  it.each(["e2b", "box"])("providerRefsFor sets only desktop ref for %s", (kind) => {
    expect(providerRefsFor(kind, "bot-sandbox")).toEqual({
      computerProviderRef: null,
      desktopProviderRef: "bot-sandbox",
    });
  });

  it("providerRefsFor defaults unknown to per-bot safety", () => {
    expect(providerRefsFor("fake", "some-ref")).toEqual({
      computerProviderRef: null,
      desktopProviderRef: "some-ref",
    });
  });

  it("counts sibling leases using controlLeaseLive semantics", async () => {
    const future = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 60_000);
    const prisma = {
      desktopSession: {
        findMany: vi.fn(async () => [
          {
            botId: "bot-b",
            state: "running",
            controlHolder: "user",
            controlLeaseId: "lease-live",
            controlLeaseUserId: "user-2",
            controlLeaseExpiresAt: future,
            controlFence: 1,
          },
          {
            botId: "bot-c",
            state: "running",
            controlHolder: "user",
            controlLeaseId: null,
            controlLeaseUserId: "user-3",
            controlLeaseExpiresAt: future,
            controlFence: 1,
          },
          {
            botId: "bot-d",
            state: "running",
            controlHolder: "user",
            controlLeaseId: "lease-dead",
            controlLeaseUserId: "user-4",
            controlLeaseExpiresAt: past,
            controlFence: 1,
          },
        ]),
      },
      run: { count: vi.fn(async () => 0) },
    } as unknown as import("@quibt/db").PrismaClient;
    const activity = await sharedComputerSiblingActivity(prisma, {
      computerId: "computer-1",
      workspaceId: "ws-1",
      botId: "bot-a",
    });
    expect(activity.otherActiveLeases).toBe(1);
    expect(shouldStopSharedComputer({ kind: "docker", ...activity })).toBe(false);
  });

  it("does not stop a shared docker while another bot is using it", () => {
    expect(
      shouldStopSharedComputer({
        kind: "docker",
        otherRunningSessions: 1,
        otherActiveRuns: 0,
      }),
    ).toBe(false);
    expect(
      shouldStopSharedComputer({
        kind: "docker",
        otherRunningSessions: 0,
        otherActiveRuns: 1,
      }),
    ).toBe(false);
    expect(
      shouldStopSharedComputer({
        kind: "docker",
        otherRunningSessions: 0,
        otherActiveRuns: 0,
        userHoldsControl: true,
      }),
    ).toBe(false);
    expect(
      shouldStopSharedComputer({
        kind: "docker",
        otherRunningSessions: 0,
        otherActiveRuns: 0,
      }),
    ).toBe(true);
  });

  it("counts active runs without requiring running session state", async () => {
    const prisma = {
      desktopSession: {
        findMany: vi.fn(async () => []),
      },
      run: { count: vi.fn(async () => 1) },
    } as unknown as import("@quibt/db").PrismaClient;
    const activity = await sharedComputerSiblingActivity(prisma, {
      computerId: "computer-1",
      workspaceId: "ws-1",
      botId: "bot-a",
    });
    expect(activity.otherActiveRuns).toBe(1);
    expect(shouldStopSharedComputer({ kind: "docker", ...activity })).toBe(false);
  });

  it("still stops a per-bot sandbox when siblings exist", () => {
    for (const kind of ["e2b", "box"]) {
      expect(
        shouldStopSharedComputer({
          kind,
          otherRunningSessions: 2,
          otherActiveRuns: 1,
        }),
      ).toBe(true);
    }
  });
});
