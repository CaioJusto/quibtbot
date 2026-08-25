import {
  type AdapterContext,
  AdapterRegistry,
  type ComputerRef,
  type SandboxProvider,
} from "@quibt/adapter-kit";
import { machineFamily, resolveDeploymentMachine } from "@quibt/core";
import { BoxSandboxEmulator } from "./box-emulator.js";
import { BoxSandboxProvider } from "./box-sandbox.js";
import { DockerSandboxProvider } from "./docker-sandbox.js";
import { ManagedSandboxEmulator } from "./e2b-emulator.js";
import { E2BSandboxProvider } from "./e2b-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";

export type SandboxFactoryFn = (opts: SandboxFactoryOptions) => SandboxProvider;

const sandboxFactories = new Map<string, SandboxFactoryFn>();

export function registerSandboxFactory(kind: string, factory: SandboxFactoryFn): void {
  sandboxFactories.set(kind, factory);
}

function registerBuiltinSandboxFactories(): void {
  if (sandboxFactories.size > 0) return;
  registerSandboxFactory(
    "docker",
    (opts) =>
      new DockerSandboxProvider(
        opts.supervisorUrl ?? "http://127.0.0.1:7091",
        opts.supervisorToken,
      ),
  );
  registerSandboxFactory(
    "remote-supervisor",
    (opts) =>
      new DockerSandboxProvider(
        opts.remoteSupervisorUrl ?? opts.supervisorUrl ?? "http://127.0.0.1:7091",
        opts.remoteSupervisorToken ?? opts.supervisorToken,
        "remote-supervisor",
      ),
  );
  registerSandboxFactory("e2b", (opts) => {
    if (!opts.e2bApiKey) throw new Error("E2B_API_KEY is required for the e2b sandbox provider");
    return new E2BSandboxProvider(opts.e2bApiKey);
  });
  registerSandboxFactory("box", (opts) => {
    if (!opts.boxApiKey) throw new Error("BOX_API_KEY is required for the box sandbox provider");
    return new BoxSandboxProvider(opts.boxApiKey);
  });
  registerSandboxFactory("e2b-emulator", () => new ManagedSandboxEmulator());
  registerSandboxFactory("box-emulator", () => new BoxSandboxEmulator());
  registerSandboxFactory("fake", () => new FakeSandboxProvider());
}

export function createSandboxProvider(kind: string, opts: SandboxFactoryOptions): SandboxProvider {
  registerBuiltinSandboxFactories();
  if (kind === "desktop") {
    throw new Error(
      "SANDBOX_PROVIDER=desktop is disabled because it is not an OS isolation boundary. Use docker, e2b, box, or remote-supervisor.",
    );
  }
  const factory = sandboxFactories.get(kind);
  if (!factory) {
    throw new Error(
      `Unknown SANDBOX_PROVIDER "${kind}". Use docker | remote-supervisor | e2b | e2b-emulator | box | box-emulator | desktop | fake.`,
    );
  }
  return factory(opts);
}

/** Live instances that this process can actually build with the given options. */
export function createSandboxRegistry(opts: SandboxFactoryOptions): AdapterRegistry {
  registerBuiltinSandboxFactories();
  const registry = new AdapterRegistry();
  for (const kind of sandboxFactories.keys()) {
    try {
      registry.register(`sandbox:${kind}`, createSandboxProvider(kind, opts));
    } catch {
      // Skip adapters that need a key or endpoint this process does not have.
    }
  }
  return registry;
}

export interface SandboxFactoryOptions {
  supervisorUrl?: string;
  supervisorToken?: string;
  remoteSupervisorUrl?: string;
  remoteSupervisorToken?: string;
  e2bApiKey?: string;
  boxApiKey?: string;
  dataDir?: string;
  desktopGrants?: string[];
  desktopGrantsByUser?: Record<string, string[]>;
}

/** How long the routed provider trusts its cached copy of the saved machine. */
export const MACHINE_CACHE_MS = 5_000;

export interface SandboxRouterDeps {
  /** `SANDBOX_PROVIDER`: what this process boots when the deployment saved nothing. */
  fallbackKind: string;
  options: SandboxFactoryOptions;
  /** The saved machine plus whether this edition is allowed to have one. */
  readSelection: () => Promise<{ saved?: string | null; canChooseMachine: boolean }>;
  /** BYOK / remote endpoint that can change after boot without restarting the process. */
  readOptions?: () => Promise<Partial<SandboxFactoryOptions>>;
  /** The kind that already provisioned this bot, so a live computer is never re-pointed. */
  readComputerKind?: (botId: string) => Promise<string | null>;
  cacheMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
  /** Seam for tests; production always builds providers with `createSandboxProvider`. */
  factory?: (kind: string, options: SandboxFactoryOptions) => SandboxProvider;
}

export interface RoutingSandboxProvider extends SandboxProvider {
  /** Forget the cached choice; called when the owner saves a new machine. */
  invalidate(): void;
  /** The provider id a *new* computer would boot into right now. */
  bootKind(): Promise<string>;
  keepAlive(computer: ComputerRef, context?: AdapterContext): Promise<void>;
}

/** Emulators stand in for their family, so `e2b-emulator` still serves an `e2b` computer. */
function familyKey(kind: string | null | undefined): string {
  const raw = (kind ?? "").trim().toLowerCase();
  return machineFamily(raw) ?? raw;
}

/**
 * The deployment picker used to write a column nobody read: every bot booted into
 * `SANDBOX_PROVIDER` no matter what the owner chose. This provider closes that gap by resolving
 * the destination per operation.
 *
 * Two rules keep it safe:
 *  - a computer that already exists is served by the provider that created it (matched by
 *    `ComputerRef.kind`, with the process provider always answering for its own family so an
 *    emulator-made computer is never handed to the real cloud API);
 *  - only `provision` follows the saved choice, so changing the machine takes effect on the next
 *    boot instead of teleporting a running desktop.
 */
export function createRoutingSandboxProvider(deps: SandboxRouterDeps): RoutingSandboxProvider {
  const now = deps.now ?? (() => Date.now());
  const cacheMs = deps.cacheMs ?? MACHINE_CACHE_MS;
  const providers = new Map<string, SandboxProvider>();
  const build = deps.factory ?? createSandboxProvider;
  const fallback = build(deps.fallbackKind, deps.options);
  providers.set(deps.fallbackKind, fallback);
  let cached: { kind: string; readAt: number } | null = null;
  let optionCache: { value: SandboxFactoryOptions; readAt: number } | null = null;

  async function resolvedOptions(): Promise<SandboxFactoryOptions> {
    if (optionCache && now() - optionCache.readAt < cacheMs) return optionCache.value;
    const extra = deps.readOptions ? await deps.readOptions().catch(() => ({})) : {};
    const value = { ...deps.options, ...extra };
    optionCache = { value, readAt: now() };
    return value;
  }

  function providerFor(kind: string, options: SandboxFactoryOptions): SandboxProvider {
    if (familyKey(kind) === familyKey(deps.fallbackKind)) return fallback;
    const existing = providers.get(kind);
    if (existing) return existing;
    const created = build(kind, options);
    providers.set(kind, created);
    return created;
  }

  /** Never let an unreachable choice take a bot down: fall back to the process provider. */
  function providerOrFallback(kind: string, options: SandboxFactoryOptions): SandboxProvider {
    try {
      return providerFor(kind, options);
    } catch (error) {
      deps.onError?.(error);
      return fallback;
    }
  }

  async function bootKind(): Promise<string> {
    if (cached && now() - cached.readAt < cacheMs) return cached.kind;
    let kind = deps.fallbackKind;
    try {
      const [selection, options] = await Promise.all([deps.readSelection(), resolvedOptions()]);
      const resolved = resolveDeploymentMachine({
        saved: selection.saved,
        envProvider: deps.fallbackKind,
        canChooseMachine: selection.canChooseMachine,
      });
      if (resolved.source === "deployment" && resolved.machine) {
        // Only accept a choice this process can actually build.
        try {
          providerFor(resolved.machine, options);
          kind =
            familyKey(resolved.machine) === familyKey(deps.fallbackKind)
              ? deps.fallbackKind
              : resolved.machine;
        } catch (error) {
          deps.onError?.(error);
        }
      }
    } catch (error) {
      deps.onError?.(error);
    }
    cached = { kind, readAt: now() };
    return kind;
  }

  function currentOptions(): SandboxFactoryOptions {
    return optionCache?.value ?? deps.options;
  }

  function forRef(computer: ComputerRef): SandboxProvider {
    return providerOrFallback(computer.kind, currentOptions());
  }

  return {
    invalidate() {
      cached = null;
      optionCache = null;
      providers.clear();
      providers.set(deps.fallbackKind, fallback);
    },
    bootKind,
    describe: () => fallback.describe(),
    async provision(request, context) {
      const kind = await bootKind();
      const options = await resolvedOptions();
      const target = providerOrFallback(kind, options);
      if (!request.providerRef) return target.provision(request, context);
      const previous = (await deps.readComputerKind?.(request.botId).catch(() => null)) ?? null;
      if (!previous || familyKey(previous) === familyKey(kind)) {
        return target.provision(request, context);
      }
      // The machine changed under a computer that already exists somewhere else. Leave nothing
      // running on the old provider, then boot a fresh one instead of handing a foreign
      // provider a reference it cannot resolve.
      await providerOrFallback(previous, options)
        .stop(
          {
            id: request.providerRef,
            botId: request.botId,
            kind: previous as ComputerRef["kind"],
            providerRef: request.providerRef,
            display: request.display,
          },
          context,
        )
        .catch((error) => deps.onError?.(error));
      return target.provision({ ...request, providerRef: undefined }, context);
    },
    execute(computer, request, context) {
      return forRef(computer).execute(computer, request, context);
    },
    connectScreen(computer, request, context) {
      return forRef(computer).connectScreen(computer, request, context);
    },
    sendInput(computer, input, lease, context) {
      return forRef(computer).sendInput(computer, input, lease, context);
    },
    snapshot(computer, context) {
      return forRef(computer).snapshot(computer, context);
    },
    // Quem não sabe responder (provedor sem `exists`) diz "está lá": só o provedor de
    // verdade pode afirmar que um computador sumiu.
    async exists(computer, context) {
      const provider = forRef(computer);
      if (!provider.exists) return true;
      return provider.exists(computer, context);
    },
    stop(computer, context) {
      return forRef(computer).stop(computer, context);
    },
    destroy(computer, context) {
      return forRef(computer).destroy(computer, context);
    },
    destroyBotSession(computer, context, options) {
      const provider = forRef(computer) as SandboxProvider & {
        destroyBotSession?: (
          ref: ComputerRef,
          ctx: typeof context,
          opts: typeof options,
        ) => Promise<void>;
      };
      if (provider.destroyBotSession) {
        return provider.destroyBotSession(computer, context, options);
      }
      if (options.preserveComputer) {
        return forRef(computer).stop(computer, context);
      }
      return forRef(computer).destroy(computer, context);
    },
    async keepAlive(computer, context) {
      const provider = forRef(computer) as SandboxProvider & {
        keepAlive?: (ref: ComputerRef, ctx?: AdapterContext) => Promise<void>;
      };
      await provider.keepAlive?.(computer, context);
    },
  };
}
