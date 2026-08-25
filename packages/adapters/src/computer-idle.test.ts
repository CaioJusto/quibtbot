import type { SandboxProvider } from "@quibt/adapter-kit";
import type { PrismaClient } from "@quibt/db";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SANDBOX_IDLE_MS, sandboxIdleMs, sleepComputerIfIdle } from "./computer-idle.js";
import { SupervisorRequestError } from "./docker-sandbox.js";
import {
  e2bCreateOptions,
  isUnrecoverableSandboxError,
  openDesktopBrowser,
  preparedOrKilled,
} from "./e2b-sandbox.js";

vi.mock("@quibt/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@quibt/db")>();
  return {
    ...actual,
    closeComputerUsage: vi.fn(async () => undefined),
    appendEvent: vi.fn(async () => undefined),
  };
});

type ProviderKind = "docker" | "remote-supervisor" | "e2b" | "box";

const providerFixtures: Record<
  ProviderKind,
  { kind: ProviderKind; sessionRef: string; computerRef: string }
> = {
  docker: {
    kind: "docker",
    sessionRef: "container-workspace",
    computerRef: "container-workspace",
  },
  "remote-supervisor": {
    kind: "remote-supervisor",
    sessionRef: "remote-workspace",
    computerRef: "remote-workspace",
  },
  e2b: {
    kind: "e2b",
    sessionRef: "e2b-bot-a",
    computerRef: "legacy-e2b-shared",
  },
  box: {
    kind: "box",
    sessionRef: "box-a",
    computerRef: "legacy-shared-box",
  },
};

type SiblingFixture = {
  botId: string;
  state: string;
  controlHolder?: string;
  controlLeaseId?: string | null;
  controlLeaseExpiresAt?: Date | null;
};

function makeIdleHarness(
  kind: ProviderKind,
  options?: {
    siblings?: SiblingFixture[];
    activeRunsOnSiblings?: number;
    claimFails?: boolean;
  },
) {
  const fixture = providerFixtures[kind];
  const desktop = {
    botId: "bot-a",
    workspaceId: "ws-1",
    computerId: "computer-1",
    display: 10,
    providerRef: fixture.sessionRef,
    screenUrl: "https://screen-a",
    state: "running",
    controlHolder: "none",
    bootClaimToken: null as string | null,
    bootClaimedAt: null as Date | null,
    controlLeaseId: null as string | null,
    controlLeaseUserId: null as string | null,
    controlLeaseExpiresAt: null as Date | null,
    computer: {
      id: "computer-1",
      kind: fixture.kind,
      providerRef: fixture.computerRef,
      userId: "user-1",
    },
  };
  const siblings = options?.siblings ?? [];
  const stop = vi.fn(async () => undefined);
  const destroy = vi.fn(async () => undefined);
  const sandbox = { stop, destroy } as unknown as SandboxProvider;
  const enqueue = vi.fn(async () => undefined);
  const orphanCreate = vi.fn(async () => undefined);
  const orphanFindFirst = vi.fn(async () => null);
  const orphanUpdate = vi.fn(async () => undefined);

  const prisma = {
    desktopSession: {
      findUnique: vi.fn(async () => desktop),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          if (where.botId !== "bot-a") return { count: 0 };
          const holder = where.controlHolder as { not?: string } | undefined;
          if (holder?.not === "user" && desktop.controlHolder === "user") return { count: 0 };
          if (where.state === "suspending" && desktop.state !== "suspending") return { count: 0 };
          if (where.state === "deleting" && desktop.state !== "deleting") return { count: 0 };
          if (where.state === "running" && desktop.state !== "running") return { count: 0 };
          if (where.bootClaimToken === null && desktop.bootClaimToken !== null) return { count: 0 };
          if (
            typeof where.bootClaimToken === "string" &&
            desktop.bootClaimToken !== where.bootClaimToken
          ) {
            return { count: 0 };
          }
          if (
            where.state === "suspending" &&
            where.bootClaimToken &&
            desktop.bootClaimToken !== where.bootClaimToken
          ) {
            return { count: 0 };
          }
          if (options?.claimFails) return { count: 0 };
          Object.assign(desktop, data);
          return { count: 1 };
        },
      ),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            computerId?: string;
            botId?: { not?: string };
            state?: { in?: string[] };
          };
        }) => {
          if (where.computerId !== "computer-1" || where.botId?.not !== "bot-a") return [];
          return siblings
            .filter((s) => !where.state?.in || where.state.in.includes(s.state))
            .map((s) => ({
              botId: s.botId,
              state: s.state,
              controlHolder: s.controlHolder ?? "none",
              controlLeaseId: s.controlLeaseId ?? null,
              controlLeaseUserId: null,
              controlLeaseExpiresAt: s.controlLeaseExpiresAt ?? null,
              controlFence: 0,
            }));
        },
      ),
    },
    run: {
      findFirst: vi.fn(async () => null),
      count: vi.fn(async ({ where }: { where: { botId?: { not?: string } } }) => {
        if (where.botId?.not === "bot-a") return options?.activeRunsOnSiblings ?? 0;
        return 0;
      }),
    },
    bot: {
      findUnique: vi.fn(async () => ({ id: "bot-a", thread: { id: "thread-a" } })),
    },
    orphanProvision: {
      findFirst: orphanFindFirst,
      create: orphanCreate,
      update: orphanUpdate,
      upsert: orphanCreate,
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    computer: {
      findUnique: vi.fn(async () => ({ bootClaimToken: null, state: "running" })),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          if (where.bootClaimToken === null && data.bootClaimToken) return { count: 1 };
          if (where.bootClaimToken && data.bootClaimedAt) return { count: 1 };
          if (where.bootClaimToken && data.bootClaimToken === null) return { count: 1 };
          return { count: 0 };
        },
      ),
    },
    $transaction: vi.fn(async (cb: (tx: typeof prisma) => Promise<void>) => cb(prisma)),
  } as unknown as PrismaClient;

  return { prisma, sandbox, stop, destroy, enqueue, desktop, fixture, orphanCreate };
}

describe("sleepComputerIfIdle", () => {
  it.each(["box", "e2b"] as const)(
    "%s bot A idle with bot B running stops only bot A sandbox",
    async (kind) => {
      const { prisma, sandbox, stop, destroy, enqueue, fixture, orphanCreate } = makeIdleHarness(
        kind,
        { siblings: [{ botId: "bot-b", state: "running" }] },
      );
      await sleepComputerIfIdle({ prisma, sandbox, wakeup: { enqueue } as never }, "bot-a");
      expect(orphanCreate).toHaveBeenCalled();
      expect(stop).toHaveBeenCalledWith(
        expect.objectContaining({
          providerRef: fixture.sessionRef,
          botId: "bot-a",
        }),
        expect.anything(),
      );
      expect(fixture.sessionRef).not.toBe(fixture.computerRef);
      expect(destroy).not.toHaveBeenCalled();
    },
  );

  it.each(["docker", "remote-supervisor"] as const)(
    "%s bot A idle with bot B running suspends locally without stopping shared sandbox",
    async (kind) => {
      const { prisma, sandbox, stop, destroy, enqueue, fixture } = makeIdleHarness(kind, {
        siblings: [{ botId: "bot-b", state: "running" }],
      });
      await sleepComputerIfIdle({ prisma, sandbox, wakeup: { enqueue } as never }, "bot-a");
      expect(stop).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
      expect(fixture.sessionRef).toBe(fixture.computerRef);
    },
  );

  it.each(["docker", "remote-supervisor"] as const)(
    "%s bot A idle alone stops the shared sandbox",
    async (kind) => {
      const { prisma, sandbox, stop, destroy, enqueue, fixture } = makeIdleHarness(kind);
      await sleepComputerIfIdle({ prisma, sandbox, wakeup: { enqueue } as never }, "bot-a");
      expect(stop).toHaveBeenCalledWith(
        expect.objectContaining({
          providerRef: fixture.computerRef,
          botId: "bot-a",
        }),
        expect.anything(),
      );
      expect(destroy).not.toHaveBeenCalled();
    },
  );

  it("does not stop shared docker while a sibling holds a live control lease", async () => {
    const future = new Date(Date.now() + 60_000);
    const { prisma, sandbox, stop, enqueue } = makeIdleHarness("docker", {
      siblings: [
        {
          botId: "bot-b",
          state: "running",
          controlHolder: "user",
          controlLeaseId: "lease-b",
          controlLeaseExpiresAt: future,
        },
      ],
    });
    await sleepComputerIfIdle({ prisma, sandbox, wakeup: { enqueue } as never }, "bot-a");
    expect(stop).not.toHaveBeenCalled();
  });

  it("does not stop shared docker while a sibling has an active run", async () => {
    const { prisma, sandbox, stop, enqueue } = makeIdleHarness("docker", {
      siblings: [{ botId: "bot-b", state: "running" }],
      activeRunsOnSiblings: 1,
    });
    await sleepComputerIfIdle({ prisma, sandbox, wakeup: { enqueue } as never }, "bot-a");
    expect(stop).not.toHaveBeenCalled();
  });

  it.each(["box", "e2b", "docker", "remote-supervisor"] as const)(
    "%s does not stop while the user holds control",
    async (kind) => {
      const { prisma, sandbox, stop, destroy, enqueue, desktop } = makeIdleHarness(kind);
      desktop.controlHolder = "user";
      await sleepComputerIfIdle({ prisma, sandbox, wakeup: { enqueue } as never }, "bot-a");
      expect(stop).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
      expect(enqueue).toHaveBeenCalled();
    },
  );

  it("does not stop when a CAS claim loses the running state race", async () => {
    const { prisma, sandbox, stop, desktop } = makeIdleHarness("box", { claimFails: true });
    await sleepComputerIfIdle({ prisma, sandbox }, "bot-a");
    expect(stop).not.toHaveBeenCalled();
    expect(desktop.state).toBe("running");
  });

  it("releases suspend claim when a run becomes active after claim", async () => {
    const { prisma, sandbox, stop, enqueue, desktop } = makeIdleHarness("box");
    vi.mocked(prisma.run.findFirst)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "run-1" } as never);
    await sleepComputerIfIdle({ prisma, sandbox, wakeup: { enqueue } as never }, "bot-a");
    expect(stop).not.toHaveBeenCalled();
    expect(desktop.state).toBe("running");
    expect(enqueue).toHaveBeenCalled();
  });

  it("records cleanup intent before provider stop", async () => {
    const { prisma, sandbox, orphanCreate } = makeIdleHarness("box");
    await sleepComputerIfIdle({ prisma, sandbox }, "bot-a");
    expect(orphanCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "pending",
          reason: expect.stringContaining("stop:idle"),
        }),
      }),
    );
  });

  it.each(["docker", "box"] as const)(
    "%s: stop que responde 404 marca suspended em vez de oscilar",
    async (kind) => {
      // Container parado depois de um reboot: o provedor não tem a sessão para parar. Antes
      // o erro subia, a linha ficava "suspending" com o claim, o recover devolvia a
      // "running" e o sono tentava de novo — para sempre.
      const { prisma, sandbox, stop, desktop } = makeIdleHarness(kind);
      stop.mockRejectedValueOnce(
        new SupervisorRequestError("stop", 404, '{"error":"session not found"}'),
      );
      await sleepComputerIfIdle({ prisma, sandbox }, "bot-a");
      expect(stop).toHaveBeenCalledTimes(1);
      expect(desktop.state).toBe("suspended");
      expect(desktop.bootClaimToken).toBeNull();
      expect(desktop.controlHolder).toBe("none");
    },
  );

  it("keeps suspending claim and pending stop intent when provider stop fails", async () => {
    const { prisma, sandbox, stop, desktop, orphanCreate } = makeIdleHarness("box");
    stop.mockRejectedValueOnce(new Error("stop failed"));
    await expect(sleepComputerIfIdle({ prisma, sandbox }, "bot-a")).rejects.toThrow("stop failed");
    expect(desktop.state).toBe("suspending");
    expect(desktop.bootClaimToken).toBeTruthy();
    expect(orphanCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "pending",
          lifecycleAction: "stop:idle",
          lifecycleToken: desktop.bootClaimToken,
        }),
      }),
    );
  });
});

describe("sandbox idle", () => {
  it("defaults to ten minutes when SANDBOX_IDLE_MS is unset", () => {
    const previous = process.env.SANDBOX_IDLE_MS;
    delete process.env.SANDBOX_IDLE_MS;
    try {
      expect(sandboxIdleMs()).toBe(DEFAULT_SANDBOX_IDLE_MS);
      expect(DEFAULT_SANDBOX_IDLE_MS).toBe(10 * 60 * 1000);
    } finally {
      if (previous === undefined) delete process.env.SANDBOX_IDLE_MS;
      else process.env.SANDBOX_IDLE_MS = previous;
    }
  });
});

describe("e2b create options", () => {
  it("pauses on timeout instead of killing the sandbox", () => {
    const opts = e2bCreateOptions("bot-1", "e2b_test");
    expect(opts.lifecycle).toEqual({ onTimeout: "pause", autoResume: false });
    expect(opts.timeoutMs).toBe(sandboxIdleMs());
    expect(opts.metadata.botId).toBe("bot-1");
  });

  it("only recreates when the sandbox is actually gone", () => {
    expect(isUnrecoverableSandboxError(new Error("sandbox not found"))).toBe(true);
    expect(isUnrecoverableSandboxError(new Error("ECONNRESET"))).toBe(false);
  });

  it("opens a browser on a new desktop", async () => {
    const launched: string[] = [];
    await openDesktopBrowser({
      launch: async (application) => {
        launched.push(application);
        if (application !== "firefox") throw new Error("missing");
      },
      open: async () => {
        throw new Error("should not fall back");
      },
    });
    expect(launched).toEqual(["google-chrome", "firefox"]);
  });
});

describe("sandbox provisioning", () => {
  it("kills a fresh sandbox when the setup after create fails", async () => {
    let killed = 0;
    const desktop = {
      kill: async () => {
        killed += 1;
      },
    };
    await expect(
      preparedOrKilled(desktop, async () => {
        throw new Error("stream refused");
      }),
    ).rejects.toThrow("stream refused");
    expect(killed).toBe(1);
  });

  it("returns the sandbox when the setup succeeds", async () => {
    const desktop = {
      kill: async () => {
        throw new Error("should not be killed");
      },
    };
    expect(await preparedOrKilled(desktop, async () => undefined)).toBe(desktop);
  });
});
