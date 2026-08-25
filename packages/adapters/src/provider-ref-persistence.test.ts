import type { ComputerRef, SandboxProvider } from "@quibt/adapter-kit";
import type { PrismaClient } from "@quibt/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiBootComputer,
  bootComputer,
  ensureWorkspaceComputer,
  warmWorkspaceComputer,
} from "./computer-boot.js";
import { DESKTOP_BOOT_STALE_MS } from "./computer-boot-claim.js";
import { workerBootComputer } from "./executor.js";
import { savedProviderRefsFromProvision } from "./provider-ref-persistence.js";

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
}));

vi.mock("@quibt/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@quibt/db")>();
  return {
    ...actual,
    openComputerUsage: vi.fn(async () => undefined),
  };
});

type SavedRefs = {
  computerProviderRef: string | null | undefined;
  desktopProviderRef: string | null | undefined;
  controlHolder?: string;
};

type ProviderKind = "docker" | "remote-supervisor" | "e2b" | "box";

const fixtures: Record<
  ProviderKind,
  {
    kind: ProviderKind;
    providerRef: string;
    expected: { computerProviderRef: string | null; desktopProviderRef: string };
  }
> = {
  docker: {
    kind: "docker",
    providerRef: "container-workspace",
    expected: {
      computerProviderRef: "container-workspace",
      desktopProviderRef: "container-workspace",
    },
  },
  "remote-supervisor": {
    kind: "remote-supervisor",
    providerRef: "remote-workspace",
    expected: {
      computerProviderRef: "remote-workspace",
      desktopProviderRef: "remote-workspace",
    },
  },
  e2b: {
    kind: "e2b",
    providerRef: "e2b-sandbox-1",
    expected: {
      computerProviderRef: null,
      desktopProviderRef: "e2b-sandbox-1",
    },
  },
  box: {
    kind: "box",
    providerRef: "box-bot-a",
    expected: {
      computerProviderRef: null,
      desktopProviderRef: "box-bot-a",
    },
  },
};

function provisionRef(kind: ProviderKind, providerRef: string): ComputerRef {
  return {
    id: `${kind}-ref`,
    botId: "bot-a",
    kind,
    providerRef,
    screenUrl: "https://screen.test/vnc",
    display: 2,
  };
}

type SessionRow = {
  botId: string;
  computerId: string;
  display: number;
  providerRef: string | null;
  screenUrl: string | null;
  state: string;
  updatedAt: Date;
  controlHolder: string;
  bootClaimToken: string | null;
  bootClaimedAt: Date | null;
  bootLastError: string | null;
  computer: { id: string; kind: string; providerRef: string | null };
};

type ComputerHarnessRow = {
  id: string;
  workspaceId: string;
  kind: string;
  providerRef: string | null;
  state: string;
  updatedAt: Date;
  bootClaimToken: string | null;
  bootClaimedAt: Date | null;
  bootLastError: string | null;
};

function staleBefore(now: Date): Date {
  return new Date(now.getTime() - DESKTOP_BOOT_STALE_MS);
}

function bootClaimable(session: SessionRow, now: Date): boolean {
  const stale = staleBefore(now);
  return (
    session.state === "stopped" ||
    session.state === "error" ||
    session.state === "suspended" ||
    (session.state === "booting" &&
      ((session.bootClaimedAt !== null && session.bootClaimedAt < stale) ||
        (session.bootClaimedAt === null && session.updatedAt < stale)))
  );
}

function computerClaimable(computer: ComputerHarnessRow, now: Date): boolean {
  const stale = staleBefore(now);
  if (
    computer.state === "stopped" ||
    computer.state === "error" ||
    computer.state === "suspended"
  ) {
    return true;
  }
  if (computer.state === "warming" || computer.state === "booting") {
    return (
      (computer.bootClaimedAt !== null && computer.bootClaimedAt < stale) ||
      (computer.bootClaimedAt === null && computer.updatedAt < stale)
    );
  }
  return false;
}

function createBootHarness(kind: ProviderKind, legacyComputerRef: string | null = null) {
  const computerUpdates: Array<Record<string, unknown>> = [];
  const desktopUpdates: Array<Record<string, unknown>> = [];
  let provisionCalls = 0;
  const sideEffects: string[] = [];

  const session: SessionRow = {
    botId: "bot-a",
    computerId: "comp-1",
    display: 1,
    providerRef: kind === "box" || kind === "e2b" ? fixtures[kind].providerRef : null,
    screenUrl: null,
    state: "stopped",
    updatedAt: new Date(),
    controlHolder: "none",
    bootClaimToken: null,
    bootClaimedAt: null,
    bootLastError: null,
    computer: {
      id: "comp-1",
      kind,
      providerRef: legacyComputerRef,
    },
  };

  const computerRow: ComputerHarnessRow = {
    id: "comp-1",
    workspaceId: "ws-1",
    kind,
    providerRef: legacyComputerRef,
    state: "stopped",
    updatedAt: new Date(),
    bootClaimToken: null,
    bootClaimedAt: null,
    bootLastError: null,
  };

  const sandbox = {
    provision: vi.fn(async () => {
      provisionCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return provisionRef(kind, fixtures[kind].providerRef);
    }),
    destroy: vi.fn(async () => undefined),
    stop: vi.fn(),
    describe: vi.fn(),
    execute: vi.fn(),
    connectScreen: vi.fn(async () => ({
      url: "https://screen.test/vnc",
      mimeType: "text/html",
      close: async () => undefined,
    })),
    sendInput: vi.fn(),
    snapshot: vi.fn(),
  } as unknown as SandboxProvider;

  const billing = vi.fn(async () => undefined);

  const prisma = {
    desktopSession: {
      findUnique: vi.fn(async () => session),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const now = new Date();
          if (where.botId === session.botId && data.bootClaimToken && data.state === "booting") {
            if (bootClaimable(session, now)) {
              Object.assign(session, data);
              session.updatedAt = now;
              return { count: 1 };
            }
            return { count: 0 };
          }
          if (
            where.botId === session.botId &&
            where.bootClaimToken === session.bootClaimToken &&
            data.bootClaimedAt
          ) {
            session.bootClaimedAt = data.bootClaimedAt as Date;
            session.updatedAt = now;
            return { count: 1 };
          }
          if (
            where.botId === session.botId &&
            where.state === "booting" &&
            where.bootClaimToken === session.bootClaimToken &&
            data.state === "error"
          ) {
            Object.assign(session, data);
            session.updatedAt = now;
            return { count: 1 };
          }
          if (where.botId === session.botId && where.bootClaimToken === session.bootClaimToken) {
            desktopUpdates.push(data);
            Object.assign(session, data);
            session.updatedAt = now;
            return { count: 1 };
          }
          if (
            where.botId === session.botId &&
            data.controlHolder === "bot" &&
            data.controlLeaseId === null
          ) {
            sideEffects.push("reclaim");
            Object.assign(session, data);
            session.updatedAt = now;
            return { count: 1 };
          }
          return { count: 0 };
        },
      ),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        desktopUpdates.push(data);
        return session;
      }),
    },
    computer: {
      findUnique: vi.fn(async () => computerRow),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        computerUpdates.push(data);
        if (data.providerRef !== undefined) {
          computerRow.providerRef = data.providerRef as string | null;
          session.computer.providerRef = data.providerRef as string | null;
        }
        if (data.state !== undefined) {
          computerRow.state = data.state as string;
        }
        return computerRow;
      }),
      upsert: vi.fn(async () => computerRow),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const now = new Date();
          if (
            where.workspaceId === computerRow.workspaceId &&
            data.bootClaimToken &&
            data.state === "warming"
          ) {
            if (computerClaimable(computerRow, now)) {
              Object.assign(computerRow, data);
              computerRow.updatedAt = now;
              return { count: 1 };
            }
            return { count: 0 };
          }
          if (
            where.workspaceId === computerRow.workspaceId &&
            where.bootClaimToken === null &&
            data.bootClaimToken &&
            !data.state
          ) {
            Object.assign(computerRow, data);
            computerRow.updatedAt = now;
            return { count: 1 };
          }
          if (
            where.workspaceId === computerRow.workspaceId &&
            where.bootClaimToken === computerRow.bootClaimToken
          ) {
            if (data.providerRef !== undefined || data.state !== undefined) {
              computerUpdates.push(data);
            }
            Object.assign(computerRow, data);
            computerRow.updatedAt = now;
            return { count: 1 };
          }
          return { count: 0 };
        },
      ),
    },
    $transaction: vi.fn(async (cb: (tx: typeof prisma) => Promise<boolean>) => {
      const snapshot = {
        state: session.state,
        bootClaimToken: session.bootClaimToken,
        bootClaimedAt: session.bootClaimedAt,
        providerRef: session.providerRef,
        screenUrl: session.screenUrl,
        controlHolder: session.controlHolder,
      };
      try {
        return await cb(prisma);
      } catch (error) {
        Object.assign(session, snapshot);
        throw error;
      }
    }),
  };

  const deps = {
    prisma: prisma as unknown as PrismaClient,
    sandbox,
    home: { resolve: () => "/tmp/home" } as never,
    dataDir: "/tmp/data",
    billing: { assertWithinPlan: billing },
    wakeup: undefined,
  };

  return {
    deps,
    session,
    computerRow,
    sandbox,
    billing,
    computerUpdates,
    desktopUpdates,
    getProvisionCalls: () => provisionCalls,
    sideEffects,
    saved(): SavedRefs {
      const computer = computerUpdates.at(-1);
      const desktop = desktopUpdates.at(-1);
      return {
        computerProviderRef: computer?.providerRef as string | null | undefined,
        desktopProviderRef: desktop?.providerRef as string | null | undefined,
        controlHolder: desktop?.controlHolder as string | undefined,
      };
    },
  };
}

function createMultiBotSharedHarness() {
  const connectCalls: Array<{ botId: string; display: number; contextBotId?: string }> = [];
  const computerRow: ComputerHarnessRow = {
    id: "comp-1",
    workspaceId: "ws-1",
    kind: "docker",
    providerRef: fixtures.docker.providerRef,
    state: "running",
    updatedAt: new Date(),
    bootClaimToken: null,
    bootClaimedAt: null,
    bootLastError: null,
  };

  const sessions: Record<string, SessionRow> = {
    "bot-a": {
      botId: "bot-a",
      computerId: "comp-1",
      display: 1,
      providerRef: null,
      screenUrl: null,
      state: "stopped",
      updatedAt: new Date(),
      controlHolder: "none",
      bootClaimToken: null,
      bootClaimedAt: null,
      bootLastError: null,
      computer: {
        id: "comp-1",
        kind: "docker",
        providerRef: fixtures.docker.providerRef,
      },
    },
    "bot-b": {
      botId: "bot-b",
      computerId: "comp-1",
      display: 2,
      providerRef: null,
      screenUrl: null,
      state: "stopped",
      updatedAt: new Date(),
      controlHolder: "none",
      bootClaimToken: null,
      bootClaimedAt: null,
      bootLastError: null,
      computer: {
        id: "comp-1",
        kind: "docker",
        providerRef: fixtures.docker.providerRef,
      },
    },
  };

  let provisionCalls = 0;

  const sandbox = {
    provision: vi.fn(async () => {
      provisionCalls += 1;
      return {
        ...provisionRef("docker", fixtures.docker.providerRef),
        screenUrl: "https://workspace-screen.test/vnc",
      };
    }),
    destroy: vi.fn(async () => undefined),
    stop: vi.fn(),
    describe: vi.fn(),
    execute: vi.fn(),
    connectScreen: vi.fn(async (computer, _request, ctx) => {
      connectCalls.push({
        botId: computer.botId,
        display: computer.display ?? 1,
        contextBotId: ctx.botId,
      });
      return {
        url: `https://screen.test/${computer.botId}-d${computer.display}`,
        mimeType: "text/html",
        close: async () => undefined,
      };
    }),
    sendInput: vi.fn(),
    snapshot: vi.fn(),
  } as unknown as SandboxProvider;

  const billing = vi.fn(async () => undefined);

  const prisma = {
    desktopSession: {
      findUnique: vi.fn(async ({ where }: { where: { botId: string } }) => sessions[where.botId]),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const botId = where.botId as string;
          const session = sessions[botId];
          if (!session) return { count: 0 };
          const now = new Date();
          if (data.bootClaimToken && data.state === "booting") {
            if (bootClaimable(session, now)) {
              Object.assign(session, data);
              session.updatedAt = now;
              return { count: 1 };
            }
            return { count: 0 };
          }
          if (where.bootClaimToken === session.bootClaimToken && data.bootClaimedAt) {
            session.bootClaimedAt = data.bootClaimedAt as Date;
            session.updatedAt = now;
            return { count: 1 };
          }
          if (
            where.state === "booting" &&
            where.bootClaimToken === session.bootClaimToken &&
            data.state === "error"
          ) {
            Object.assign(session, data);
            session.updatedAt = now;
            return { count: 1 };
          }
          if (where.bootClaimToken === session.bootClaimToken) {
            Object.assign(session, data);
            session.updatedAt = now;
            return { count: 1 };
          }
          if (data.controlHolder === "bot" && data.controlLeaseId === null) {
            Object.assign(session, data);
            session.updatedAt = now;
            return { count: 1 };
          }
          return { count: 0 };
        },
      ),
      update: vi.fn(),
    },
    computer: {
      findUnique: vi.fn(async () => computerRow),
      update: vi.fn(async () => computerRow),
      upsert: vi.fn(async () => computerRow),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const now = new Date();
          if (
            where.workspaceId === computerRow.workspaceId &&
            where.bootClaimToken === null &&
            data.bootClaimToken &&
            !data.state
          ) {
            Object.assign(computerRow, data);
            computerRow.updatedAt = now;
            return { count: 1 };
          }
          if (
            where.workspaceId === computerRow.workspaceId &&
            where.bootClaimToken === computerRow.bootClaimToken &&
            data.bootClaimToken === null
          ) {
            Object.assign(computerRow, data);
            computerRow.updatedAt = now;
            return { count: 1 };
          }
          return { count: 0 };
        },
      ),
    },
    $transaction: vi.fn(async (cb: (tx: typeof prisma) => Promise<boolean>) => cb(prisma)),
  };

  const deps = {
    prisma: prisma as unknown as PrismaClient,
    sandbox,
    home: { resolve: () => "/tmp/home" } as never,
    dataDir: "/tmp/data",
    billing: { assertWithinPlan: billing },
    wakeup: undefined,
  };

  return {
    deps,
    sessions,
    sandbox,
    connectCalls,
    getProvisionCalls: () => provisionCalls,
  };
}

describe("savedProviderRefsFromProvision", () => {
  for (const kind of Object.keys(fixtures) as ProviderKind[]) {
    it(`${kind} refs`, () => {
      expect(savedProviderRefsFromProvision(fixtures[kind])).toEqual(fixtures[kind].expected);
    });
  }
});

describe("provider ref persistence across boot paths", () => {
  const context = {
    operationId: "test",
    traceId: "test",
    workspaceId: "ws-1",
    userId: "user-1",
    botId: "bot-a",
    signal: new AbortController().signal,
  };

  const previousSandboxProvider = process.env.SANDBOX_PROVIDER;

  afterEach(() => {
    if (previousSandboxProvider === undefined) delete process.env.SANDBOX_PROVIDER;
    else process.env.SANDBOX_PROVIDER = previousSandboxProvider;
    vi.restoreAllMocks();
  });

  for (const kind of Object.keys(fixtures) as ProviderKind[]) {
    const fixture = fixtures[kind];
    const legacyComputerRef = kind === "box" || kind === "e2b" ? "legacy-shared-ref" : null;

    it(`worker boot (${workerBootComputer.name}) persists ${kind} refs`, async () => {
      const harness = createBootHarness(kind, legacyComputerRef);
      await workerBootComputer(harness.deps as never, "bot-a", context);
      expect(harness.saved()).toMatchObject(fixture.expected);
      expect(harness.saved().controlHolder).toBeUndefined();
      expect(harness.sideEffects).toContain("reclaim");
    });

    it(`warm boot (bootComputer) persists ${kind} refs with controlHolder bot`, async () => {
      const harness = createBootHarness(kind, legacyComputerRef);
      await bootComputer(harness.deps, "bot-a", context);
      expect(harness.saved()).toMatchObject({
        ...fixture.expected,
        controlHolder: "bot",
      });
    });

    it(`warmWorkspaceComputer(botId) assigns controlHolder bot for ${kind}`, async () => {
      const harness = createBootHarness(kind, legacyComputerRef);
      await warmWorkspaceComputer(harness.deps, "ws-1", "user-1", "bot-a");
      expect(harness.saved().controlHolder).toBe("bot");
      expect(harness.saved()).toMatchObject(fixture.expected);
    });

    it(`API boot (${apiBootComputer.name}) persists ${kind} refs`, async () => {
      const harness = createBootHarness(kind, legacyComputerRef);
      await apiBootComputer(harness.deps, "bot-a", context);
      expect(harness.saved()).toMatchObject(fixture.expected);
      expect(harness.saved().controlHolder).toBeUndefined();
    });
  }

  it("warm workspace boot persists computer refs without a bot", async () => {
    process.env.SANDBOX_PROVIDER = "docker";
    const harness = createBootHarness("docker");
    await warmWorkspaceComputer(harness.deps, "ws-1", "user-1");
    expect(harness.computerRow.providerRef).toBe("container-workspace");
    expect(harness.computerRow.state).toBe("running");
  });

  it("warm workspace without bot refuses per-bot providers", async () => {
    for (const kind of ["box", "e2b"] as const) {
      process.env.SANDBOX_PROVIDER = kind;
      const harness = createBootHarness(kind);
      await expect(warmWorkspaceComputer(harness.deps, "ws-1", "user-1")).rejects.toThrow(
        /workspace-scoped provider/,
      );
      expect(harness.getProvisionCalls()).toBe(0);
    }
  });

  it("worker boot preserves billing before provision and reclaim after persist", async () => {
    const harness = createBootHarness("docker");
    const order: string[] = [];
    harness.billing.mockImplementation(async () => {
      order.push("billing");
    });
    harness.sandbox.provision = vi.fn(async () => {
      order.push("provision");
      return provisionRef("docker", fixtures.docker.providerRef);
    });
    await workerBootComputer(harness.deps as never, "bot-a", context);
    expect(order).toEqual(["billing", "provision"]);
    expect(harness.sideEffects).toContain("reclaim");
  });

  it("concurrent boots provision exactly once and reuse persisted refs", async () => {
    const harness = createBootHarness("docker");
    const [first, second] = await Promise.all([
      bootComputer(harness.deps, "bot-a", context),
      bootComputer(harness.deps, "bot-a", context),
    ]);
    expect(harness.getProvisionCalls()).toBe(1);
    expect(first.providerRef).toBe(fixtures.docker.providerRef);
    expect(second.providerRef).toBe(fixtures.docker.providerRef);
  });

  it("ensureWorkspaceComputer provisions once then reuses running computer", async () => {
    process.env.SANDBOX_PROVIDER = "docker";
    const harness = createBootHarness("docker");
    const ensureContext = {
      operationId: "test",
      traceId: "test",
      workspaceId: "ws-1",
      userId: "user-1",
      signal: new AbortController().signal,
    };
    const first = await ensureWorkspaceComputer(harness.deps, "ws-1", "user-1", ensureContext);
    expect(harness.getProvisionCalls()).toBe(1);
    expect(first.providerRef).toBe(fixtures.docker.providerRef);

    const second = await ensureWorkspaceComputer(harness.deps, "ws-1", "user-1", ensureContext);
    expect(harness.getProvisionCalls()).toBe(1);
    expect(second.providerRef).toBe(fixtures.docker.providerRef);
    expect(harness.computerRow.state).toBe("running");
  });

  it("shared docker bot boot reuses workspace computer without reprovisioning", async () => {
    process.env.SANDBOX_PROVIDER = "docker";
    const harness = createBootHarness("docker");
    harness.computerRow.state = "running";
    harness.computerRow.providerRef = fixtures.docker.providerRef;
    harness.session.computer.providerRef = fixtures.docker.providerRef;

    await bootComputer(harness.deps, "bot-a", context);
    expect(harness.getProvisionCalls()).toBe(0);
    expect(harness.session.state).toBe("running");
    expect(harness.session.providerRef).toBe(fixtures.docker.providerRef);
  });

  it("shared docker boots connectScreen per bot/display without reusing workspace screenUrl", async () => {
    process.env.SANDBOX_PROVIDER = "docker";
    const harness = createMultiBotSharedHarness();

    await bootComputer(harness.deps, "bot-a", context);
    await bootComputer(harness.deps, "bot-b", { ...context, botId: "bot-b" });

    expect(harness.getProvisionCalls()).toBe(0);
    expect(harness.connectCalls).toEqual([
      { botId: "bot-a", display: 1, contextBotId: "bot-a" },
      { botId: "bot-b", display: 2, contextBotId: "bot-b" },
    ]);
    expect(harness.sessions["bot-a"]!.providerRef).toBe(fixtures.docker.providerRef);
    expect(harness.sessions["bot-b"]!.providerRef).toBe(fixtures.docker.providerRef);
    expect(harness.sessions["bot-a"]!.screenUrl).toBe("https://screen.test/bot-a-d1");
    expect(harness.sessions["bot-b"]!.screenUrl).toBe("https://screen.test/bot-b-d2");
  });

  it("destroys orphan sandbox when persist fails after provision", async () => {
    const harness = createBootHarness("box");
    vi.mocked(harness.deps.prisma.computer.update).mockRejectedValueOnce(
      new Error("persist failed"),
    );
    await expect(bootComputer(harness.deps, "bot-a", context)).rejects.toThrow("persist failed");
    expect(harness.sandbox.destroy).toHaveBeenCalledOnce();
    expect(harness.session.state).toBe("error");
    expect(harness.session.bootClaimToken).toBeNull();
  });
});
