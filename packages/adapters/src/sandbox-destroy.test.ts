import type { AdapterContext, ComputerRef, SandboxProvider } from "@quibt/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { destroyBotSessionForRef, shouldPreserveSharedComputer } from "./sandbox-destroy.js";

const ctx: AdapterContext = {
  operationId: "test",
  traceId: "test",
  workspaceId: "ws-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

const ref: ComputerRef = {
  id: "container-1",
  botId: "bot-a",
  kind: "docker",
  providerRef: "container-1",
};

describe("shouldPreserveSharedComputer", () => {
  it("preserves shared docker when a sibling session is still running", () => {
    expect(
      shouldPreserveSharedComputer("docker", {
        otherRunningSessions: 1,
        otherActiveRuns: 0,
        otherActiveLeases: 0,
      }),
    ).toBe(true);
  });

  it("allows shared teardown when no siblings remain", () => {
    expect(
      shouldPreserveSharedComputer("docker", {
        otherRunningSessions: 0,
        otherActiveRuns: 0,
        otherActiveLeases: 0,
      }),
    ).toBe(false);
  });

  it("never preserves per-bot sandboxes", () => {
    expect(
      shouldPreserveSharedComputer("box", {
        otherRunningSessions: 1,
        otherActiveRuns: 0,
        otherActiveLeases: 0,
      }),
    ).toBe(false);
  });
});

describe("destroyBotSessionForRef", () => {
  it("calls destroyBotSession when the provider exposes it", async () => {
    const destroyBotSession = vi.fn(async () => undefined);
    const sandbox = { destroyBotSession } as unknown as SandboxProvider;
    await destroyBotSessionForRef(sandbox, ref, ctx, { preserveComputer: true });
    expect(destroyBotSession).toHaveBeenCalledWith(ref, ctx, { preserveComputer: true });
  });

  it("falls back to stop when preserveComputer is true without destroyBotSession", async () => {
    const stop = vi.fn(async () => undefined);
    const destroy = vi.fn(async () => undefined);
    const sandbox = { stop, destroy } as unknown as SandboxProvider;
    await destroyBotSessionForRef(sandbox, ref, ctx, { preserveComputer: true });
    expect(stop).toHaveBeenCalledWith(ref, ctx);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("falls back to destroy when preserveComputer is false", async () => {
    const destroy = vi.fn(async () => undefined);
    const sandbox = { destroy } as unknown as SandboxProvider;
    await destroyBotSessionForRef(sandbox, ref, ctx, { preserveComputer: false });
    expect(destroy).toHaveBeenCalledWith(ref, ctx);
  });
});
