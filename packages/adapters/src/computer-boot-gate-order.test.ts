import type { AdapterContext, SandboxProvider } from "@quibt/adapter-kit";
import type { PrismaClient } from "@quibt/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootComputer } from "./computer-boot.js";
import * as bootClaim from "./computer-boot-claim.js";
import * as sessionLifecycle from "./session-lifecycle.js";

vi.mock("@quibt/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@quibt/db")>();
  return {
    ...actual,
    openComputerUsage: vi.fn(async () => undefined),
  };
});

const context: AdapterContext & { userId: string } = {
  operationId: "boot",
  traceId: "boot",
  workspaceId: "ws-1",
  userId: "user-1",
  botId: "bot-b",
  signal: new AbortController().signal,
};

function makeSharedBootHarness() {
  const session = {
    botId: "bot-b",
    workspaceId: "ws-1",
    computerId: "comp-1",
    display: 2,
    providerRef: null as string | null,
    screenUrl: null as string | null,
    state: "stopped",
    controlHolder: "none",
    bootClaimToken: null as string | null,
    bootClaimedAt: null as Date | null,
    computer: {
      id: "comp-1",
      kind: "docker",
      providerRef: "container-workspace",
      state: "running",
    },
  };
  const computer = {
    workspaceId: "ws-1",
    kind: "docker",
    providerRef: "container-workspace",
    state: "running",
    bootClaimToken: "delete-gate" as string | null,
    bootClaimedAt: new Date(),
  };
  const sandbox = {
    provision: vi.fn(),
    connectScreen: vi.fn(async () => ({
      url: "https://screen.test/vnc",
      mimeType: "text/html",
      close: async () => undefined,
    })),
    describe: vi.fn(),
    execute: vi.fn(),
    sendInput: vi.fn(),
    snapshot: vi.fn(),
    stop: vi.fn(),
    destroy: vi.fn(),
  } as unknown as SandboxProvider;
  const prisma = {
    desktopSession: {
      findUnique: vi.fn(async () => session),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(session, data);
        return { count: 1 };
      }),
    },
    computer: {
      findUnique: vi.fn(async () => computer),
      upsert: vi.fn(async () => computer),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    $transaction: vi.fn(async (cb: (tx: typeof prisma) => Promise<unknown>) => cb(prisma)),
  } as unknown as PrismaClient;
  return {
    deps: {
      prisma,
      sandbox,
      home: { resolve: () => "/tmp/home" } as never,
      dataDir: "/tmp/data",
    },
    session,
    computer,
  };
}

describe("shared boot session gate ordering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not claim desktop boot while the computer session gate is unavailable", async () => {
    const { deps, session } = makeSharedBootHarness();
    vi.spyOn(sessionLifecycle, "claimComputerSessionStartGate").mockResolvedValue(null);
    vi.spyOn(sessionLifecycle, "waitForComputerSessionGateOrRecover").mockResolvedValue(false);
    const claimDesktopBootSpy = vi.spyOn(bootClaim, "claimDesktopBoot");

    await expect(bootComputer(deps, "bot-b", context)).rejects.toThrow(
      /workspace computer session gate/i,
    );
    expect(session.state).toBe("stopped");
    expect(claimDesktopBootSpy).not.toHaveBeenCalled();
  });

  it("claims desktop boot only after the computer session gate is acquired", async () => {
    const { deps, session, computer } = makeSharedBootHarness();
    computer.bootClaimToken = null;
    const order: string[] = [];
    vi.spyOn(sessionLifecycle, "claimComputerSessionStartGate").mockImplementation(async () => {
      order.push("gate");
      return { token: "gate-token", claimedAt: new Date() };
    });
    vi.spyOn(sessionLifecycle, "validateComputerSessionStartGate").mockResolvedValue(true);
    vi.spyOn(sessionLifecycle, "releaseComputerSessionStartGate").mockResolvedValue(true);
    vi.spyOn(bootClaim, "claimDesktopBoot").mockImplementation(async () => {
      order.push("desktop-boot");
      return { token: "boot-token", claimedAt: new Date() };
    });
    vi.spyOn(bootClaim, "persistDesktopSessionBoot").mockResolvedValue(true);

    await bootComputer(deps, "bot-b", context);
    expect(order).toEqual(["gate", "desktop-boot"]);
    expect(session.state).not.toBe("booting");
  });
});
