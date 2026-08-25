import type { SandboxProvider } from "@quibt/adapter-kit";
import { machineFamily } from "@quibt/core";
import { describe, expect, it } from "vitest";
import {
  createRoutingSandboxProvider,
  createSandboxProvider,
  MACHINE_CACHE_MS,
} from "./sandbox-factory.js";

describe("createSandboxProvider", () => {
  it("returns fake sandbox when explicitly requested", () => {
    const sandbox = createSandboxProvider("fake", {});
    expect(sandbox.describe().id).toBe("fake");
  });

  it("throws on unknown provider", () => {
    expect(() => createSandboxProvider("bogus", {})).toThrow(
      'Unknown SANDBOX_PROVIDER "bogus". Use docker | remote-supervisor | e2b | e2b-emulator | box | box-emulator | desktop | fake.',
    );
  });

  it("requires and wires the Box API key", () => {
    expect(() => createSandboxProvider("box", {})).toThrow(/BOX_API_KEY is required/);
    expect(createSandboxProvider("box", { boxApiKey: "box_test_key" }).describe().id).toBe("box");
  });

  it("builds a remote supervisor as Docker with a distinct kind", () => {
    const sandbox = createSandboxProvider("remote-supervisor", {
      remoteSupervisorUrl: "https://vps.example:7091",
      remoteSupervisorToken: "tok",
    });
    expect(sandbox.describe().id).toBe("remote-supervisor");
  });

  it("refuses the host desktop provider", () => {
    expect(() => createSandboxProvider("desktop", {})).toThrow(/not an OS isolation boundary/);
  });
});

describe("createRoutingSandboxProvider", () => {
  interface Call {
    provider: string;
    op: string;
    ref?: string;
  }

  function stub(id: string, calls: Call[]): SandboxProvider {
    const describe = () => ({
      id,
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: {} as never,
    });
    return {
      describe,
      provision: async (request: { botId: string; providerRef?: string }) => {
        calls.push({ provider: id, op: "provision", ref: request.providerRef });
        return {
          id: `${id}-ref`,
          botId: request.botId,
          kind: (machineFamily(id) ?? "fake") as "docker" | "e2b" | "fake",
          providerRef: `${id}-ref`,
        };
      },
      execute: async function* () {},
      connectScreen: async () => ({ url: null }),
      sendInput: async () => undefined,
      snapshot: async () => ({ id: "snap" }),
      stop: async (computer: { providerRef: string }) => {
        calls.push({ provider: id, op: "stop", ref: computer.providerRef });
      },
      destroy: async () => undefined,
      // Só o Docker sabe dizer que um container sumiu; os outros stubs não têm `exists`.
      ...(id === "docker"
        ? {
            exists: async (computer: { providerRef: string }) => {
              calls.push({ provider: id, op: "exists", ref: computer.providerRef });
              return false;
            },
          }
        : {}),
    } as unknown as SandboxProvider;
  }

  function harness(options: {
    fallbackKind?: string;
    saved?: string | null;
    canChooseMachine?: boolean;
    computerKind?: string | null;
    keys?: { e2bApiKey?: string; boxApiKey?: string };
  }) {
    const calls: Call[] = [];
    const errors: unknown[] = [];
    let reads = 0;
    let clock = 0;
    const routed = createRoutingSandboxProvider({
      fallbackKind: options.fallbackKind ?? "docker",
      options: options.keys ?? {},
      readSelection: async () => {
        reads += 1;
        return { saved: options.saved ?? null, canChooseMachine: options.canChooseMachine ?? true };
      },
      readComputerKind: async () => options.computerKind ?? null,
      now: () => clock,
      onError: (error) => errors.push(error),
      factory: (kind, opts) => {
        if (kind === "e2b" && !opts.e2bApiKey) throw new Error("E2B_API_KEY is required");
        return stub(kind, calls);
      },
    });
    return {
      routed,
      calls,
      errors,
      reads: () => reads,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  const ctx = {
    operationId: "test",
    traceId: "test",
    workspaceId: "ws-1",
    userId: "user-1",
    signal: new AbortController().signal,
  };

  it("boots new computers on the saved machine instead of SANDBOX_PROVIDER", async () => {
    const { routed, calls } = harness({
      fallbackKind: "docker",
      saved: "e2b",
      keys: { e2bApiKey: "e2b_key" },
    });
    expect(await routed.bootKind()).toBe("e2b");
    await routed.provision({ botId: "bot-1", homePath: "/home" }, ctx);
    expect(calls).toEqual([{ provider: "e2b", op: "provision", ref: undefined }]);
  });

  it("ignores a saved machine the edition forbids or the deploy cannot build", async () => {
    const cloud = harness({ saved: "e2b", canChooseMachine: false, keys: { e2bApiKey: "k" } });
    expect(await cloud.routed.bootKind()).toBe("docker");

    const keyless = harness({ saved: "e2b", canChooseMachine: true });
    expect(await keyless.routed.bootKind()).toBe("docker");
    expect(keyless.errors).toHaveLength(1);
  });

  it("keeps serving a live computer from the provider that created it", async () => {
    const { routed, calls } = harness({
      fallbackKind: "docker",
      saved: "e2b",
      keys: { e2bApiKey: "e2b_key" },
    });
    await routed.stop(
      { id: "c1", botId: "bot-1", kind: "docker", providerRef: "container-1" },
      ctx,
    );
    expect(calls).toEqual([{ provider: "docker", op: "stop", ref: "container-1" }]);
  });

  it("never hands an emulator-made computer to the real cloud provider", async () => {
    const { routed, calls } = harness({
      fallbackKind: "e2b-emulator",
      saved: "e2b",
      keys: { e2bApiKey: "e2b_key" },
    });
    await routed.stop({ id: "c1", botId: "bot-1", kind: "e2b", providerRef: "sbx-1" }, ctx);
    expect(calls).toEqual([{ provider: "e2b-emulator", op: "stop", ref: "sbx-1" }]);
    // The emulator already stands for e2b, so nothing switches provider either.
    expect(await routed.bootKind()).toBe("e2b-emulator");
  });

  it("stops the old computer and drops its reference when the machine changed", async () => {
    const { routed, calls } = harness({
      fallbackKind: "docker",
      saved: "e2b",
      computerKind: "docker",
      keys: { e2bApiKey: "e2b_key" },
    });
    await routed.provision({ botId: "bot-1", homePath: "/home", providerRef: "container-1" }, ctx);
    expect(calls).toEqual([
      { provider: "docker", op: "stop", ref: "container-1" },
      { provider: "e2b", op: "provision", ref: undefined },
    ]);
  });

  it("reuses the reference while the machine is unchanged", async () => {
    const { routed, calls } = harness({
      fallbackKind: "docker",
      saved: "docker",
      computerKind: "docker",
    });
    await routed.provision({ botId: "bot-1", homePath: "/home", providerRef: "container-1" }, ctx);
    expect(calls).toEqual([{ provider: "docker", op: "provision", ref: "container-1" }]);
  });

  it("caches the choice briefly and forgets it when the owner saves a new one", async () => {
    const h = harness({ saved: null });
    await h.routed.bootKind();
    await h.routed.bootKind();
    expect(h.reads()).toBe(1);
    h.advance(MACHINE_CACHE_MS + 1);
    await h.routed.bootKind();
    expect(h.reads()).toBe(2);
    h.routed.invalidate();
    await h.routed.bootKind();
    expect(h.reads()).toBe(3);
  });

  it("keeps booting on the process provider when the deployment lookup fails", async () => {
    const calls: Call[] = [];
    const errors: unknown[] = [];
    const routed = createRoutingSandboxProvider({
      fallbackKind: "docker",
      options: {},
      readSelection: async () => {
        throw new Error("db down");
      },
      onError: (error) => errors.push(error),
      factory: (kind) => stub(kind, calls),
    });
    expect(await routed.bootKind()).toBe("docker");
    expect(errors).toHaveLength(1);
  });

  it("asks the provider of the computer whether it still exists, and says yes when it cannot tell", async () => {
    // Sem este repasse o worker (que só enxerga o roteador) nunca descobria que o container
    // do workspace tinha sumido, e cada comando voltava "computer not found".
    const h = harness({});
    const gone = await h.routed.exists?.(
      { id: "docker-ref", botId: "bot-1", kind: "docker", providerRef: "docker-ref" },
      ctx,
    );
    expect(gone).toBe(false);
    expect(h.calls).toContainEqual({ provider: "docker", op: "exists", ref: "docker-ref" });
    const unknown = await h.routed.exists?.(
      { id: "fake-ref", botId: "bot-1", kind: "fake", providerRef: "fake-ref" },
      ctx,
    );
    expect(unknown).toBe(true);
  });
});
