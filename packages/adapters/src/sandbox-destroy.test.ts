import type { AdapterContext, ComputerRef, SandboxProvider } from "@quibt/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { SupervisorRequestError } from "./docker-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import {
  destroyBotSessionForRef,
  isSandboxAlreadyGoneError,
  shouldPreserveSharedComputer,
  stopSandboxUnlessAlreadyGone,
} from "./sandbox-destroy.js";

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

/**
 * A exclusão é retomável: o retry re-chama o destroy sobre um providerRef que a passada
 * anterior JÁ apagou. Se "já não existe" subir como erro, a intent nunca fecha — troca-se
 * "não retoma" por "retoma e trava". Erro de verdade (rede, credencial, 5xx) continua
 * tendo de falhar, senão a exclusão mente que terminou e o recurso vaza.
 */
describe("isSandboxAlreadyGoneError", () => {
  it("treats provider 404/410 as the end state", () => {
    expect(isSandboxAlreadyGoneError(new SupervisorRequestError("destroy", 404))).toBe(true);
    expect(isSandboxAlreadyGoneError({ status: 410, message: "gone" })).toBe(true);
  });

  it("treats provider not-found wording as the end state", () => {
    // box: `box api POST /boxes/x/stop failed: 404 ...`; e2b: mensagem do SDK; docker: `docker rm`.
    expect(
      isSandboxAlreadyGoneError(new Error("box api POST /boxes/box-a/stop failed: 404 not found")),
    ).toBe(true);
    expect(isSandboxAlreadyGoneError(new Error("sandbox not found"))).toBe(true);
    expect(isSandboxAlreadyGoneError(new Error("The sandbox was already killed"))).toBe(true);
    expect(isSandboxAlreadyGoneError(new Error("No such container: quibt-ws-1"))).toBe(true);
    expect(isSandboxAlreadyGoneError(new Error("box does not exist"))).toBe(true);
  });

  it("keeps real failures as failures", () => {
    expect(isSandboxAlreadyGoneError(new SupervisorRequestError("destroy", 500))).toBe(false);
    expect(
      isSandboxAlreadyGoneError(
        new SupervisorRequestError("destroy", 503, JSON.stringify({ code: "docker-down" })),
      ),
    ).toBe(false);
    expect(
      isSandboxAlreadyGoneError(
        new Error("box api POST /boxes/box-a/stop failed: 401 unauthorized"),
      ),
    ).toBe(false);
    expect(isSandboxAlreadyGoneError(new Error("fetch failed"))).toBe(false);
    expect(
      isSandboxAlreadyGoneError(
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4488"), { code: "ECONNREFUSED" }),
      ),
    ).toBe(false);
    expect(isSandboxAlreadyGoneError(new Error("destroy failed"))).toBe(false);
    expect(isSandboxAlreadyGoneError(new Error("provider returned 500: sandbox not found"))).toBe(
      false,
    );
  });

  it("reads the cause chain a fetch wrapper leaves behind", () => {
    const network = new Error("fetch failed", {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.box"), { code: "ENOTFOUND" }),
    });
    expect(isSandboxAlreadyGoneError(network)).toBe(false);
    const gone = new Error("destroy failed", { cause: new SupervisorRequestError("destroy", 404) });
    expect(isSandboxAlreadyGoneError(gone)).toBe(true);
    const mixed = Object.assign(new Error("provider failed", { cause: gone.cause }), {
      status: 503,
    });
    expect(isSandboxAlreadyGoneError(mixed)).toBe(false);
  });
});

describe("stopSandboxUnlessAlreadyGone", () => {
  it("accepts the real Box not-found wording as an idempotent stop", async () => {
    const stop = vi.fn(async () => {
      throw new Error("box api POST /boxes/box-a/stop failed: 404 not found");
    });
    await expect(
      stopSandboxUnlessAlreadyGone({ stop } as unknown as SandboxProvider, ref, ctx),
    ).resolves.toBeUndefined();
  });

  it("does not hide a provider outage that happens to mention not found", async () => {
    const stop = vi.fn(async () => {
      throw new Error("provider returned 503: sandbox not found");
    });
    await expect(
      stopSandboxUnlessAlreadyGone({ stop } as unknown as SandboxProvider, ref, ctx),
    ).rejects.toThrow(/503/);
  });
});

describe("destroyBotSessionForRef idempotence", () => {
  it("swallows a provider 404 on the destroy retry", async () => {
    const destroyBotSession = vi.fn(async () => {
      throw new SupervisorRequestError("destroy", 404);
    });
    const sandbox = { destroyBotSession } as unknown as SandboxProvider;
    await expect(
      destroyBotSessionForRef(sandbox, ref, ctx, { preserveComputer: false }),
    ).resolves.toBeUndefined();
    expect(destroyBotSession).toHaveBeenCalledOnce();
  });

  it("swallows an already-gone stop when the shared computer must be kept", async () => {
    const stop = vi.fn(async () => {
      throw new Error("box api POST /boxes/box-a/stop failed: 404 box not found");
    });
    const sandbox = { stop, destroy: vi.fn() } as unknown as SandboxProvider;
    await expect(
      destroyBotSessionForRef(sandbox, ref, ctx, { preserveComputer: true }),
    ).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("still fails on a real provider error", async () => {
    const destroy = vi.fn(async () => {
      throw new SupervisorRequestError("destroy", 500);
    });
    const sandbox = { destroy } as unknown as SandboxProvider;
    await expect(
      destroyBotSessionForRef(sandbox, ref, ctx, { preserveComputer: false }),
    ).rejects.toThrow(/500/);
  });

  it("stays silent when the emulator ref is destroyed twice", async () => {
    const sandbox = new FakeSandboxProvider({ scope: "bot" });
    const fakeRef: ComputerRef = {
      id: "fake-ws-1-bot-a",
      botId: "bot-a",
      kind: "fake",
      providerRef: "fake-ws-1-bot-a",
    };
    await destroyBotSessionForRef(sandbox, fakeRef, ctx, { preserveComputer: false });
    await expect(
      destroyBotSessionForRef(sandbox, fakeRef, ctx, { preserveComputer: false }),
    ).resolves.toBeUndefined();
  });
});
