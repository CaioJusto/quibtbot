import type { ComputerInput, ComputerRef, SandboxProvider } from "@quibt/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import {
  executeComputerToolAction,
  lockComputerForAgent,
  parseComputerToolAction,
  sandboxSupportsAgentInput,
} from "./executor.js";

const computer: ComputerRef = {
  id: "computer-1",
  botId: "bot-1",
  kind: "docker",
  providerRef: "computer-1",
  display: 2,
};

const context = {
  operationId: "run-1",
  traceId: "run-1",
  workspaceId: "workspace-1",
  userId: "user-1",
  botId: "bot-1",
  runId: "run-1",
  signal: new AbortController().signal,
};

const lease = {
  leaseId: "agent:run-1:7",
  holder: "bot" as const,
  fence: 7,
};

function sandboxHarness(agentInput = true) {
  const calls: string[] = [];
  const sendInput = vi.fn(async (_computer: ComputerRef, _input: ComputerInput) => {
    calls.push("input");
  });
  const snapshot = vi.fn(async () => {
    calls.push("snapshot");
    return { id: "snapshot-1", createdAt: "2026-08-26T00:00:00.000Z" };
  });
  const sandbox = {
    describe: () => ({
      id: "test",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: {
        graphical: true,
        agentInput,
        pty: true,
        snapshots: true,
        takeover: true,
        persistentHome: true,
      },
    }),
    sendInput,
    snapshot,
  } as unknown as SandboxProvider;
  return { calls, sandbox, sendInput, snapshot };
}

describe("computer built-in", () => {
  it("declares one-action input with the six actions in this wave", () => {
    const tool = builtinAgentTools.find((candidate) => candidate.name === "computer");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema).toMatchObject({
      required: ["action"],
      properties: {
        action: {
          enum: ["screenshot", "click", "type", "key", "scroll", "wait"],
        },
      },
    });
  });

  it("declares provider support explicitly and resolves routed providers by computer", () => {
    const supported = sandboxHarness(true).sandbox;
    const unsupported = sandboxHarness(false).sandbox;
    expect(sandboxSupportsAgentInput(supported, computer)).toBe(true);
    expect(sandboxSupportsAgentInput(unsupported, computer)).toBe(false);

    const routed = {
      ...supported,
      describeFor: vi.fn(() => unsupported.describe()),
    } as SandboxProvider & { describeFor: () => ReturnType<SandboxProvider["describe"]> };
    expect(sandboxSupportsAgentInput(routed, computer)).toBe(false);
    expect(routed.describeFor).toHaveBeenCalledWith(computer);
  });
});

describe("computer executor action", () => {
  it.each([
    [
      { action: "click", x: 120, y: 45, button: "right" },
      { kind: "pointer", type: "click", x: 120, y: 45, button: "right" },
    ],
    [
      { action: "type", text: "olá" },
      { kind: "clipboard", text: "olá" },
    ],
    [
      { action: "key", key: "c", modifiers: ["ctrl", "shift"] },
      { kind: "key", key: "c", modifiers: ["ctrl", "shift"] },
    ],
    [
      { action: "scroll", direction: "down" },
      { kind: "key", key: "Page_Down" },
    ],
  ])("sends one input for %s and observes only after it", async (args, expectedInput) => {
    const harness = sandboxHarness();
    const result = await executeComputerToolAction({
      sandbox: harness.sandbox,
      computer,
      args,
      lease,
      context,
      capture: async () => {
        harness.calls.push("capture");
        return { mimeType: "image/png", data: "cG5n" };
      },
    });

    expect(harness.sendInput).toHaveBeenCalledTimes(1);
    expect(harness.sendInput).toHaveBeenCalledWith(computer, expectedInput, lease, context);
    expect(harness.snapshot).toHaveBeenCalledTimes(1);
    expect(harness.calls).toEqual(["input", "snapshot", "capture"]);
    expect(result).toMatchObject({
      ok: true,
      snapshot: { id: "snapshot-1" },
      observation: { mimeType: "image/png", data: "cG5n" },
    });
  });

  it("takes a screenshot observation without injecting input", async () => {
    const harness = sandboxHarness();
    const result = await executeComputerToolAction({
      sandbox: harness.sandbox,
      computer,
      args: { action: "screenshot" },
      lease,
      context,
    });
    expect(harness.sendInput).not.toHaveBeenCalled();
    expect(harness.snapshot).toHaveBeenCalledTimes(1);
    expect(harness.calls).toEqual(["snapshot"]);
    expect(result).toMatchObject({ ok: true, action: "screenshot" });
  });

  it("waits once, then observes, and caps the delay at ten seconds", async () => {
    const harness = sandboxHarness();
    const wait = vi.fn(async () => {
      harness.calls.push("wait");
    });
    await executeComputerToolAction({
      sandbox: harness.sandbox,
      computer,
      args: { action: "wait", milliseconds: 99_000 },
      lease,
      context,
      wait,
    });
    expect(wait).toHaveBeenCalledWith(10_000, context.signal);
    expect(harness.sendInput).not.toHaveBeenCalled();
    expect(harness.calls).toEqual(["wait", "snapshot"]);
  });

  it("rejects malformed actions before input or observation", async () => {
    const harness = sandboxHarness();
    const result = await executeComputerToolAction({
      sandbox: harness.sandbox,
      computer,
      args: { action: "click", x: -1, y: 4 },
      lease,
      context,
    });
    expect(result).toEqual({ error: "click requires non-negative x and y." });
    expect(harness.sendInput).not.toHaveBeenCalled();
    expect(harness.snapshot).not.toHaveBeenCalled();
  });

  it("normalizes scroll and validates the supported action set", () => {
    expect(parseComputerToolAction({ action: "scroll", direction: "up" })).toEqual({
      action: "scroll",
      input: { kind: "key", key: "Page_Up" },
    });
    expect(parseComputerToolAction({ action: "drag" })).toEqual({
      error: "action must be screenshot, click, type, key, scroll, or wait.",
    });
  });

  describe("computer executor control gate", () => {
    const now = new Date("2026-08-26T12:00:00.000Z");

    function gateHarness(
      input: {
        runCount?: number;
        state?: string;
        controlFence?: number;
        controlCount?: number;
      } = {},
    ) {
      const runUpdate = vi.fn(async () => ({ count: input.runCount ?? 1 }));
      const findSession = vi.fn(async () => ({
        state: input.state ?? "running",
        controlFence: input.controlFence ?? 9,
        controlHolder: "bot",
        waitingTakeover: false,
      }));
      const controlUpdate = vi.fn(async () => ({ count: input.controlCount ?? 1 }));
      return {
        runUpdate,
        findSession,
        controlUpdate,
        tx: {
          run: { updateMany: runUpdate },
          desktopSession: {
            findUnique: findSession,
            updateMany: controlUpdate,
          },
        },
      };
    }

    it("locks the live run fence and the bot control fence", async () => {
      const harness = gateHarness({ controlFence: 12 });
      const result = await lockComputerForAgent(harness.tx as never, {
        runId: "run-1",
        workerId: "worker-1",
        runFence: 4,
        botId: "bot-1",
        now,
      });
      expect(result).toEqual({ ok: true, controlFence: 12 });
      expect(harness.runUpdate).toHaveBeenCalledWith({
        where: {
          id: "run-1",
          status: "running",
          leaseOwner: "worker-1",
          leaseFence: 4,
          leaseExpiresAt: { gt: now },
        },
        data: { leaseOwner: "worker-1" },
      });
      expect(harness.controlUpdate).toHaveBeenCalledWith({
        where: {
          botId: "bot-1",
          state: "running",
          controlHolder: "bot",
          waitingTakeover: false,
          controlFence: 12,
        },
        data: { controlHolder: "bot" },
      });
    });

    it("refuses a stale or expired run before touching desktop control", async () => {
      const harness = gateHarness({ runCount: 0 });
      await expect(
        lockComputerForAgent(harness.tx as never, {
          runId: "run-1",
          workerId: "worker-old",
          runFence: 3,
          botId: "bot-1",
          now,
        }),
      ).resolves.toMatchObject({ ok: false, code: "run_lease_lost" });
      expect(harness.findSession).not.toHaveBeenCalled();
      expect(harness.controlUpdate).not.toHaveBeenCalled();
    });

    it("refuses input when takeover changed the control holder or fence", async () => {
      const harness = gateHarness({ controlFence: 13, controlCount: 0 });
      await expect(
        lockComputerForAgent(harness.tx as never, {
          runId: "run-1",
          workerId: "worker-1",
          runFence: 4,
          botId: "bot-1",
          now,
        }),
      ).resolves.toMatchObject({ ok: false, code: "takeover_active" });
    });
  });
});
