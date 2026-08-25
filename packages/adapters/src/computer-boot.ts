import { mkdir } from "node:fs/promises";
import type {
  AdapterContext,
  AgentHomeStore,
  ComputerRef,
  SandboxProvider,
  WakeupDriver,
} from "@quibt/adapter-kit";
import { openComputerUsage, type PrismaClient } from "@quibt/db";
import {
  BootClaimLostError,
  claimComputerBoot,
  claimDesktopBoot,
  computerRefFromComputer,
  computerRefFromSession,
  type DesktopSessionWithComputer,
  persistComputerBoot,
  persistDesktopBoot,
  persistDesktopSessionBoot,
  recordComputerBootCleanupFailure,
  recordDesktopBootCleanupFailure,
  releaseComputerBootFailure,
  releaseDesktopBootFailure,
  renewComputerBootClaim,
  renewDesktopBootClaim,
  waitForComputerBoot,
  waitForDesktopBoot,
  withBootClaimHeartbeat,
} from "./computer-boot-claim.js";
import {
  combineAbortSignals,
  destroyOrphanProvisionIfSafe,
  ProvisionBootTimeoutError,
  provisionBootTimeoutMs,
  runProvisionWithTimeout,
} from "./computer-boot-provision.js";
import { scheduleComputerSleep } from "./computer-idle.js";
import { resolveAgentHomePath } from "./home.js";
import {
  claimComputerSessionStartGate,
  releaseComputerSessionStartGate,
  validateComputerSessionStartGate,
  waitForComputerSessionGateOrRecover,
} from "./session-lifecycle.js";
import { isWorkspaceScopedSandbox, workspaceProviderRef } from "./workspace-computer.js";

export function sandboxKindFromEnv(): string {
  return process.env.SANDBOX_PROVIDER ?? "docker";
}

export function scheduleComputerWarm(
  wakeup:
    | WakeupDriver
    | {
        enqueue: (job: {
          name: string;
          payload: Record<string, unknown>;
          jobKey?: string;
        }) => Promise<void>;
      }
    | undefined,
  workspaceId: string,
  userId: string,
  botId?: string,
): void {
  if (!wakeup) return;
  void wakeup.enqueue({
    name: "computer.warm",
    payload: { workspaceId, userId, ...(botId ? { botId } : {}) },
    jobKey: `computer.warm:${workspaceId}`,
  });
}

export type BootComputerOptions = {
  assignControlToBot?: boolean;
  afterPersist?: (prisma: PrismaClient, botId: string) => Promise<void>;
  provisionTimeoutMs?: number;
};

export type BootComputerDeps = {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  dataDir?: string;
  wakeup?: WakeupDriver;
  billing?: {
    assertWithinPlan(workspaceId: string, check: "tokens" | "computer"): Promise<void>;
  };
};

type WorkspaceEnsureContext = AdapterContext & {
  userId: string;
  operationId: string;
  traceId: string;
};

/**
 * Asks the provider where a running session's screen is and writes the answer down.
 *
 * A session can be `running` with no `screenUrl`: taking control flips the row to running on its
 * own, and a boot that finds the row already running returns early without ever asking. Nothing
 * else fills the gap, so the app was left holding a live control lease over a screen it had no
 * address for — "Você tem o controle" printed over a picture of a desktop, and nothing to click.
 * The write is guarded by `state: "running"` so it can never resurrect a session that has since
 * been suspended or deleted.
 */
export async function ensureDesktopScreenUrl(
  deps: Pick<BootComputerDeps, "prisma" | "sandbox">,
  session: Pick<
    DesktopSessionWithComputer,
    "botId" | "display" | "providerRef" | "screenUrl" | "computer"
  >,
  context: AdapterContext,
  /**
   * O endereço guardado envelhece. A porta do noVNC vem do display, e o display é
   * reatribuído quando a sessão morre e volta — então uma linha antiga podia apontar
   * para a porta de outro bot, ou para uma que ninguém mais serve: a tela abria preta
   * e ficava piscando, com o controle na mão. Ao abrir a tela e ao assumir o controle
   * — que são momentos raros — vale perguntar ao provedor e corrigir o que está escrito.
   */
  options?: { refresh?: boolean },
): Promise<string | undefined> {
  if (session.screenUrl && !options?.refresh) return session.screenUrl;
  const providerRef = workspaceProviderRef(session) ?? session.providerRef;
  if (!providerRef) return undefined;
  // A provider that cannot answer must not fail the boot that asked: the caller ends up where
  // it already was, with no screen recorded, and can try again.
  const screen = await (async () => {
    try {
      return await deps.sandbox.connectScreen(
        {
          id: providerRef,
          botId: session.botId,
          kind: session.computer.kind as ComputerRef["kind"],
          providerRef,
          display: session.display,
        },
        { view: "stream" },
        { ...context, botId: session.botId },
      );
    } catch {
      return null;
    }
  })();
  if (!screen?.url) return session.screenUrl ?? undefined;
  if (screen.url === session.screenUrl) return screen.url;
  try {
    await deps.prisma.desktopSession.updateMany({
      where: { botId: session.botId, state: "running" },
      data: { screenUrl: screen.url },
    });
  } catch {
    // Not recording it only costs the next caller another lookup.
  }
  return screen.url;
}

async function releaseComputerClaimOnFailure(
  deps: BootComputerDeps,
  workspaceId: string,
  token: string,
  error: unknown,
  persisted: boolean,
  provisionedRef: ComputerRef | null,
  context: AdapterContext,
  kind: string,
): Promise<void> {
  if (provisionedRef && !persisted) {
    await destroyOrphanProvisionIfSafe({
      prisma: deps.prisma,
      sandbox: deps.sandbox,
      context,
      ref: provisionedRef,
      kind,
      workspaceId,
      computerClaim: { workspaceId, token },
    });
    const released = await releaseComputerBootFailure(deps.prisma, workspaceId, token, error);
    if (!released) {
      await recordComputerBootCleanupFailure(deps.prisma, workspaceId, token, error);
    }
  } else if (!persisted) {
    const released = await releaseComputerBootFailure(deps.prisma, workspaceId, token, error);
    if (!released) {
      await recordComputerBootCleanupFailure(deps.prisma, workspaceId, token, error);
    }
  }
}

async function sharedSessionRef(
  deps: BootComputerDeps,
  shared: ComputerRef,
  botId: string,
  display: number,
  context: AdapterContext,
): Promise<Pick<ComputerRef, "kind" | "providerRef" | "screenUrl" | "display">> {
  const computerRef: ComputerRef = {
    id: shared.providerRef ?? shared.id,
    botId,
    kind: shared.kind,
    providerRef: shared.providerRef,
    display,
  };
  const screen = await deps.sandbox.connectScreen(
    computerRef,
    { view: "stream" },
    { ...context, botId },
  );
  return {
    kind: shared.kind,
    providerRef: shared.providerRef,
    screenUrl: screen.url ?? undefined,
    display,
  };
}

/**
 * Ensures the workspace-scoped computer is running once per workspace (claim + provision + CAS).
 * Used by workspace warm and per-bot boot for docker / remote-supervisor.
 */
export async function ensureWorkspaceComputer(
  deps: BootComputerDeps,
  workspaceId: string,
  userId: string,
  context: WorkspaceEnsureContext,
  options?: { provisionTimeoutMs?: number; kind?: string },
): Promise<ComputerRef> {
  const envKind = options?.kind ?? sandboxKindFromEnv();
  if (!isWorkspaceScopedSandbox(envKind)) {
    throw new Error(
      `Workspace computer ensure requires a workspace-scoped provider, not ${envKind}`,
    );
  }

  await deps.prisma.computer.upsert({
    where: { workspaceId },
    create: { workspaceId, userId, kind: envKind, state: "stopped" },
    update: {},
  });

  let existing = await deps.prisma.computer.findUnique({ where: { workspaceId } });
  const kind = existing?.kind ?? envKind;
  if (
    existing?.state === "running" &&
    existing.providerRef &&
    !existing.bootClaimToken &&
    deps.sandbox.exists &&
    !(await deps.sandbox.exists(computerRefFromComputer(existing as never), context))
  ) {
    // O container do workspace sumiu (imagem nova, Docker reiniciado, `rm`): a linha
    // "running" apontava para nada, e uma sessão suspensa que acordava aqui ganhava um
    // computador fantasma — cada comando voltava "computer not found". Esquece e provisiona.
    await forgetVanishedWorkspaceComputer(deps.prisma, existing.id);
    existing = await deps.prisma.computer.findUnique({ where: { workspaceId } });
  }
  if (existing?.state === "running" && existing.providerRef) {
    if (existing.bootClaimToken) {
      const released = await waitForComputerSessionGateOrRecover(deps.prisma, workspaceId);
      if (!released) throw new Error("Timed out waiting for workspace computer session gate");
      const refreshed = await deps.prisma.computer.findUnique({ where: { workspaceId } });
      if (!refreshed?.providerRef) throw new Error("Workspace computer missing after session gate");
      return computerRefFromComputer(refreshed as never);
    }
    return computerRefFromComputer(existing as never);
  }

  const claim = await claimComputerBoot(deps.prisma, workspaceId);
  if (!claim) {
    const waited = await waitForComputerBoot(deps.prisma, workspaceId);
    if (!waited) throw new Error("Timed out waiting for workspace computer boot");
    return computerRefFromComputer(waited);
  }

  const timeoutMs = options?.provisionTimeoutMs ?? provisionBootTimeoutMs();
  const abort = new AbortController();
  let provisionedRef: ComputerRef | null = null;
  let persisted = false;

  try {
    const homePath = resolveAgentHomePath(
      deps.home,
      "workspace",
      deps.dataDir ?? "./data",
      workspaceId,
    );
    await mkdir(homePath, { recursive: true });

    provisionedRef = await withBootClaimHeartbeat(
      () => renewComputerBootClaim(deps.prisma, workspaceId, claim.token),
      () =>
        runProvisionWithTimeout(
          (signal) =>
            deps.sandbox.provision(
              {
                botId: "workspace",
                homePath,
                providerRef: existing?.providerRef ?? undefined,
              },
              { ...context, signal },
            ),
          {
            timeoutMs,
            parentSignal: combineAbortSignals(context.signal, abort.signal),
            onLateResolve: (lateRef) =>
              destroyOrphanProvisionIfSafe({
                prisma: deps.prisma,
                sandbox: deps.sandbox,
                context: { ...context, signal: context.signal },
                ref: lateRef,
                kind,
                workspaceId,
                computerClaim: { workspaceId, token: claim.token },
              }),
          },
        ),
      { abortOnLostClaim: abort },
    );
    persisted = await persistComputerBoot(deps.prisma, workspaceId, claim.token, provisionedRef);
    if (!persisted) {
      throw new Error("Lost workspace computer boot claim before persist");
    }
    return provisionedRef;
  } catch (error) {
    if (error instanceof BootClaimLostError && error.result) {
      provisionedRef = error.result as ComputerRef;
    }
    await releaseComputerClaimOnFailure(
      deps,
      workspaceId,
      claim.token,
      error,
      persisted,
      provisionedRef,
      context,
      kind,
    );
    throw error;
  } finally {
    abort.abort();
  }
}

/** Bring the workspace VM up without a bot — Quibt Bot warms the computer at signup. */
export async function warmWorkspaceComputer(
  deps: BootComputerDeps,
  workspaceId: string,
  userId: string,
  botId?: string,
  options?: { provisionTimeoutMs?: number },
): Promise<ComputerRef | null> {
  if (botId) {
    return bootComputer(
      deps,
      botId,
      {
        operationId: "computer.warm",
        traceId: "computer.warm",
        workspaceId,
        userId,
        botId,
        signal: new AbortController().signal,
      },
      { assignControlToBot: true, provisionTimeoutMs: options?.provisionTimeoutMs },
    );
  }

  await deps.billing?.assertWithinPlan(workspaceId, "computer");
  const kind = sandboxKindFromEnv();
  if (!isWorkspaceScopedSandbox(kind)) {
    throw new Error(
      `Workspace warm without a bot requires a workspace-scoped provider (docker or remote-supervisor), not ${kind}`,
    );
  }

  return ensureWorkspaceComputer(
    deps,
    workspaceId,
    userId,
    {
      operationId: "computer.warm",
      traceId: "computer.warm",
      workspaceId,
      userId,
      signal: new AbortController().signal,
    },
    { provisionTimeoutMs: options?.provisionTimeoutMs },
  );
}

async function bootSharedDesktopSession(
  deps: BootComputerDeps,
  botId: string,
  existing: {
    botId: string;
    computerId: string;
    display: number;
    computer: { kind: string };
  },
  shared: ComputerRef,
  context: AdapterContext,
  options?: BootComputerOptions,
): Promise<ComputerRef> {
  let sessionGate: { token: string } | null = null;
  try {
    sessionGate = await claimComputerSessionStartGate(deps.prisma, context.workspaceId);
    if (!sessionGate) {
      const released = await waitForComputerSessionGateOrRecover(deps.prisma, context.workspaceId);
      if (!released) throw new Error("Timed out waiting for workspace computer session gate");
      sessionGate = await claimComputerSessionStartGate(deps.prisma, context.workspaceId);
      if (!sessionGate) throw new Error("Could not acquire workspace computer session gate");
    }
    if (
      !(await validateComputerSessionStartGate(deps.prisma, context.workspaceId, sessionGate.token))
    ) {
      throw new Error("Lost workspace computer session gate before boot");
    }

    const claim = await claimDesktopBoot(deps.prisma, botId);
    if (!claim) {
      const waited = await waitForDesktopBoot(deps.prisma, botId);
      if (!waited) throw new Error("Timed out waiting for computer boot");
      scheduleComputerSleep(deps.wakeup, botId);
      return computerRefFromSession(waited);
    }

    const assignControlToBot = options?.assignControlToBot !== false;
    let persisted = false;
    try {
      const sessionRef = await sharedSessionRef(deps, shared, botId, existing.display, context);
      persisted = await persistDesktopSessionBoot(deps.prisma, {
        botId,
        token: claim.token,
        ref: sessionRef,
        existing,
        assignControlToBot,
      });
      if (!persisted) {
        throw new Error("Lost desktop boot claim before persist");
      }
      await options?.afterPersist?.(deps.prisma, botId);
      await openComputerUsage(deps.prisma, {
        workspaceId: context.workspaceId,
        botId,
      });
      scheduleComputerSleep(deps.wakeup, botId);
      return {
        ...shared,
        botId,
        display: existing.display,
        screenUrl: sessionRef.screenUrl,
      };
    } catch (error) {
      if (!persisted) {
        const released = await releaseDesktopBootFailure(deps.prisma, botId, claim.token, error);
        if (!released) {
          await recordDesktopBootCleanupFailure(deps.prisma, botId, claim.token, error);
        }
      }
      throw error;
    }
  } finally {
    if (sessionGate) {
      await releaseComputerSessionStartGate(deps.prisma, context.workspaceId, sessionGate.token);
    }
  }
}

async function bootPerBotDesktopSession(
  deps: BootComputerDeps,
  botId: string,
  existing: {
    botId: string;
    computerId: string;
    display: number;
    providerRef: string | null;
    computer: { kind: string; providerRef: string | null };
  },
  homePath: string,
  context: AdapterContext,
  options?: BootComputerOptions,
): Promise<ComputerRef> {
  const claim = await claimDesktopBoot(deps.prisma, botId);
  if (!claim) {
    const waited = await waitForDesktopBoot(deps.prisma, botId);
    if (!waited) throw new Error("Timed out waiting for computer boot");
    scheduleComputerSleep(deps.wakeup, botId);
    return computerRefFromSession(waited);
  }

  const assignControlToBot = options?.assignControlToBot !== false;
  const timeoutMs = options?.provisionTimeoutMs ?? provisionBootTimeoutMs();
  const abort = new AbortController();
  let provisionedRef: ComputerRef | null = null;
  let persisted = false;

  try {
    await mkdir(homePath, { recursive: true });

    provisionedRef = await withBootClaimHeartbeat(
      () => renewDesktopBootClaim(deps.prisma, botId, claim.token),
      () =>
        runProvisionWithTimeout(
          (signal) =>
            deps.sandbox.provision(
              {
                botId,
                homePath,
                providerRef: workspaceProviderRef(existing),
                display: existing.display,
              },
              { ...context, signal },
            ),
          {
            timeoutMs,
            parentSignal: combineAbortSignals(context.signal, abort.signal),
            onLateResolve: (lateRef) =>
              destroyOrphanProvisionIfSafe({
                prisma: deps.prisma,
                sandbox: deps.sandbox,
                context: { ...context, signal: context.signal },
                ref: lateRef,
                kind: existing.computer.kind,
                workspaceId: context.workspaceId,
                desktopClaim: { botId, token: claim.token },
              }),
          },
        ),
      { abortOnLostClaim: abort },
    );
    persisted = await persistDesktopBoot(deps.prisma, {
      botId,
      computerId: existing.computerId,
      token: claim.token,
      ref: provisionedRef,
      existing,
      assignControlToBot,
    });
    if (!persisted) {
      throw new Error("Lost desktop boot claim before persist");
    }
    await options?.afterPersist?.(deps.prisma, botId);
    await openComputerUsage(deps.prisma, {
      workspaceId: context.workspaceId,
      botId,
    });
    scheduleComputerSleep(deps.wakeup, botId);
    return provisionedRef;
  } catch (error) {
    if (error instanceof BootClaimLostError && error.result) {
      provisionedRef = error.result as ComputerRef;
    }
    if (provisionedRef && !persisted) {
      await destroyOrphanProvisionIfSafe({
        prisma: deps.prisma,
        sandbox: deps.sandbox,
        context,
        ref: provisionedRef,
        kind: existing.computer.kind,
        workspaceId: context.workspaceId,
        desktopClaim: { botId, token: claim.token },
      });
      const released = await releaseDesktopBootFailure(deps.prisma, botId, claim.token, error);
      if (!released) {
        await recordDesktopBootCleanupFailure(deps.prisma, botId, claim.token, error);
      }
    } else if (!persisted) {
      const released = await releaseDesktopBootFailure(deps.prisma, botId, claim.token, error);
      if (!released) {
        await recordDesktopBootCleanupFailure(deps.prisma, botId, claim.token, error);
      }
    }
    throw error;
  } finally {
    abort.abort();
  }
}

export async function bootComputer(
  deps: BootComputerDeps,
  botId: string,
  context: AdapterContext & { userId: string },
  options?: BootComputerOptions,
): Promise<ComputerRef> {
  await deps.billing?.assertWithinPlan(context.workspaceId, "computer");
  let existing = await deps.prisma.desktopSession.findUnique({
    where: { botId },
    include: { computer: true },
  });
  if (!existing) throw new Error("Bot is missing its desktop session");

  if (
    existing.state === "running" &&
    workspaceProviderRef(existing) &&
    (await workspaceComputerVanished(deps, existing, context))
  ) {
    // O container sumiu por baixo do banco (imagem nova, Docker reiniciado, `rm` manual):
    // sem isto cada comando voltava "computer not found" até o sono por ociosidade zerar a
    // linha. Esquece o que está escrito e segue pelo caminho normal de boot, que recria.
    await forgetVanishedWorkspaceComputer(deps.prisma, existing.computerId);
    existing = await deps.prisma.desktopSession.findUnique({
      where: { botId },
      include: { computer: true },
    });
    if (!existing) throw new Error("Bot is missing its desktop session");
  }

  if (existing.state === "running" && workspaceProviderRef(existing)) {
    scheduleComputerSleep(deps.wakeup, botId);
    // Already up, but not necessarily addressable: a row can reach `running` without a screen
    // URL. Booting is the moment to repair that, otherwise the caller opens the computer and
    // finds nothing to connect to.
    const screenUrl = await ensureDesktopScreenUrl(deps, existing, context, { refresh: true });
    return { ...computerRefFromSession(existing), screenUrl };
  }

  if (isWorkspaceScopedSandbox(existing.computer.kind)) {
    const shared = await ensureWorkspaceComputer(
      deps,
      context.workspaceId,
      context.userId,
      {
        operationId: context.operationId,
        traceId: context.traceId,
        workspaceId: context.workspaceId,
        userId: context.userId,
        signal: context.signal,
      },
      {
        provisionTimeoutMs: options?.provisionTimeoutMs,
        kind: existing.computer.kind,
      },
    );
    return bootSharedDesktopSession(deps, botId, existing, shared, context, options);
  }

  const homePath = resolveAgentHomePath(
    deps.home,
    botId,
    deps.dataDir ?? "./data",
    context.workspaceId,
  );
  return bootPerBotDesktopSession(deps, botId, existing, homePath, context, options);
}

/** Only a workspace-scoped computer (docker / VPS) that the provider says is gone. */
async function workspaceComputerVanished(
  deps: Pick<BootComputerDeps, "sandbox">,
  session: DesktopSessionWithComputer,
  context: AdapterContext,
): Promise<boolean> {
  if (!isWorkspaceScopedSandbox(session.computer.kind)) return false;
  if (!deps.sandbox.exists) return false;
  const ref = computerRefFromSession(session);
  return !(await deps.sandbox.exists(ref, { ...context, botId: session.botId }));
}

/**
 * Marca como paradas as sessões e o computador de workspace cujo container não existe mais.
 * Só mexe em linhas sem claim em andamento: um boot ou um sono no meio do caminho termina
 * o próprio trabalho e escreve o estado final por conta própria.
 */
export async function forgetVanishedWorkspaceComputer(
  prisma: PrismaClient,
  computerId: string,
): Promise<void> {
  await prisma.desktopSession.updateMany({
    where: { computerId, state: "running", bootClaimToken: null },
    data: {
      state: "stopped",
      screenUrl: null,
      controlHolder: "none",
      controlLeaseId: null,
      controlLeaseUserId: null,
      controlLeaseExpiresAt: null,
    },
  });
  await prisma.computer.updateMany({
    where: { id: computerId, state: "running", bootClaimToken: null },
    data: { state: "stopped" },
  });
}

/** API `computer.boot` persistence path (billing asserted by the router before calling). */
export async function apiBootComputer(
  deps: BootComputerDeps,
  botId: string,
  context: AdapterContext & { userId: string },
): Promise<ComputerRef> {
  return bootComputer(deps, botId, context, { assignControlToBot: false });
}

export { ProvisionBootTimeoutError };
