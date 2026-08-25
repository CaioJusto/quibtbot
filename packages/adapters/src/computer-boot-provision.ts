import type { ComputerRef, SandboxProvider } from "@quibt/adapter-kit";
import type { PrismaClient } from "@quibt/db";
import {
  DESKTOP_BOOT_POLL_MS,
  DESKTOP_BOOT_WAIT_MS,
  waitForDesktopBoot,
} from "./computer-boot-claim.js";
import { isPerBotSandbox, isWorkspaceScopedSandbox } from "./workspace-computer.js";

/** Default bounded wait for sandbox provision during boot. */
export const DEFAULT_PROVISION_BOOT_TIMEOUT_MS = 300_000;

/** Bounded wait while another boot claim may be finishing before orphan destroy. */
export const DEFAULT_ORPHAN_CLEANUP_WAIT_MS = DESKTOP_BOOT_WAIT_MS;

export function provisionBootTimeoutMs(): number {
  const raw = process.env.BOOT_PROVISION_TIMEOUT_MS;
  if (!raw) return DEFAULT_PROVISION_BOOT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROVISION_BOOT_TIMEOUT_MS;
}

export class ProvisionBootTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Sandbox provision timed out after ${timeoutMs}ms`);
    this.name = "ProvisionBootTimeoutError";
  }
}

type CombinedAbortSignal = AbortSignal & { dispose: () => void };

/** Portable AbortSignal merge with explicit listener cleanup. */
export function combineAbortSignals(...signals: (AbortSignal | undefined)[]): CombinedAbortSignal {
  const active = signals.filter((s): s is AbortSignal => s !== undefined);
  if (typeof AbortSignal !== "undefined" && "any" in AbortSignal && active.length > 0) {
    return Object.assign(AbortSignal.any(active), { dispose: () => undefined });
  }
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  for (const signal of active) {
    if (signal.aborted) {
      ctrl.abort();
      break;
    }
    signal.addEventListener("abort", onAbort);
  }
  return Object.assign(ctrl.signal, {
    dispose: () => {
      for (const signal of active) signal.removeEventListener("abort", onAbort);
    },
  });
}

type TrackedPromise<T> = {
  promise: Promise<T>;
  awaitLate: (
    waitMs: number,
  ) => Promise<
    | { status: "pending" }
    | { status: "resolved"; value: T }
    | { status: "rejected"; error: unknown }
  >;
};

/** Tracks settlement without leaving floating handlers on the public promise. */
export function trackPromise<T>(source: Promise<T>): TrackedPromise<T> {
  let settled = false;
  let late:
    | { status: "pending" }
    | { status: "resolved"; value: T }
    | { status: "rejected"; error: unknown } = { status: "pending" };

  const promise = source.then(
    (value) => {
      settled = true;
      late = { status: "resolved", value };
      return value;
    },
    (error) => {
      settled = true;
      late = { status: "rejected", error };
      throw error;
    },
  );

  return {
    promise,
    awaitLate: async (waitMs) => {
      if (settled) return late;
      if (waitMs <= 0) return { status: "pending" };
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(late), waitMs);
        promise
          .then(() => {
            clearTimeout(timer);
            resolve(late);
          })
          .catch(() => {
            clearTimeout(timer);
            resolve(late);
          });
      });
    },
  };
}

function invokeLate<T>(
  racedLost: boolean,
  onLateResolve?: (value: T) => void | Promise<void>,
  onLateReject?: (error: unknown) => void | Promise<void>,
  value?: T,
  error?: unknown,
): void {
  if (!racedLost) return;
  if (value !== undefined) {
    void (async () => {
      try {
        await onLateResolve?.(value);
      } catch {
        // Best-effort late cleanup must not mask the boot failure.
      }
    })();
  } else if (error !== undefined) {
    void (async () => {
      try {
        await onLateReject?.(error);
      } catch {
        // Best-effort late cleanup must not mask the boot failure.
      }
    })();
  }
}

/**
 * Runs sandbox provision with a bounded timeout and optional parent abort. If the provider
 * ignores cancellation, late settlement on the original promise triggers `onLateResolve` /
 * `onLateReject` without blocking the thrown error path.
 */
export async function runProvisionWithTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  options?: {
    timeoutMs?: number;
    parentSignal?: AbortSignal;
    onLateResolve?: (value: T) => void | Promise<void>;
    onLateReject?: (error: unknown) => void | Promise<void>;
  },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? provisionBootTimeoutMs();
  const timeoutCtrl = new AbortController();
  const combined = combineAbortSignals(timeoutCtrl.signal, options?.parentSignal);

  let racedLost = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const finish = (fn: () => void) => {
    if (finished) return;
    finished = true;
    clearTimer();
    fn();
  };

  const source = run(combined);

  source.then(
    (value) => invokeLate(racedLost, options?.onLateResolve, options?.onLateReject, value),
    (error) =>
      invokeLate(racedLost, options?.onLateResolve, options?.onLateReject, undefined, error),
  );

  try {
    return await new Promise<T>((resolve, reject) => {
      const rejectRaced = (error: unknown) => {
        racedLost = true;
        finish(() => reject(error));
      };

      timer = setTimeout(() => {
        rejectRaced(new ProvisionBootTimeoutError(timeoutMs));
        timeoutCtrl.abort();
      }, timeoutMs);

      const onParentAbort = () => {
        if (!finished) {
          rejectRaced(options?.parentSignal?.reason ?? new Error("Aborted"));
        }
      };
      if (options?.parentSignal) {
        if (options.parentSignal.aborted) {
          onParentAbort();
        } else {
          options.parentSignal.addEventListener("abort", onParentAbort, { once: true });
        }
      }

      source.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    });
  } finally {
    finish(() => undefined);
    combined.dispose();
  }
}

function isOrphanProvisionUniqueConflict(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

function bootOrphanUpdateWhere(input: {
  workspaceId: string;
  provider: string;
  providerRef: string;
}) {
  return {
    workspaceId: input.workspaceId,
    provider: input.provider,
    providerRef: input.providerRef,
    lifecycleAction: null,
  };
}

export async function recordOrphanProvisionForReconciliation(
  prisma: PrismaClient,
  input: {
    ref: ComputerRef;
    reason: string;
    workspaceId: string;
    botId?: string;
    status?: "pending" | "resolved";
  },
): Promise<void> {
  const candidateBotId = input.botId ?? input.ref.botId;
  const botId = candidateBotId && candidateBotId !== "workspace" ? candidateBotId : null;
  const status = input.status ?? "pending";
  const bootOrphanLifecycleClear = {
    lifecycleAction: null,
    lifecycleToken: null,
    sessionBotId: null,
    refSnapshotKind: null,
    refSnapshotProviderRef: null,
  };
  const rowKey = {
    workspaceId: input.workspaceId,
    provider: input.ref.kind,
    providerRef: input.ref.providerRef,
  };
  try {
    await prisma.orphanProvision.create({
      data: {
        ...rowKey,
        botId,
        reason: input.reason.slice(0, 500),
        status,
        ...bootOrphanLifecycleClear,
      },
    });
  } catch (error) {
    if (!isOrphanProvisionUniqueConflict(error)) throw error;
    await prisma.orphanProvision.updateMany({
      where: bootOrphanUpdateWhere(rowKey),
      data: {
        reason: input.reason.slice(0, 500),
        status,
        botId,
        ...bootOrphanLifecycleClear,
      },
    });
  }
}

/** Records durable cleanup intent before an external stop/destroy. */
export async function recordProviderCleanupIntent(
  prisma: PrismaClient,
  input: {
    ref: ComputerRef;
    reason: string;
    workspaceId: string;
    botId?: string;
  },
): Promise<void> {
  await recordOrphanProvisionForReconciliation(prisma, {
    ...input,
    status: "pending",
  });
}

/** Marks a cleanup intent resolved after a successful provider call. */
export async function resolveProviderCleanupIntent(
  prisma: PrismaClient,
  input: {
    ref: ComputerRef;
    workspaceId: string;
    botId?: string;
  },
): Promise<void> {
  await recordOrphanProvisionForReconciliation(prisma, {
    ref: input.ref,
    reason: "provider cleanup resolved",
    workspaceId: input.workspaceId,
    botId: input.botId,
    status: "resolved",
  });
}

export type OrphanCleanupInput = {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  context: { signal?: AbortSignal };
  ref: ComputerRef;
  kind: string;
  workspaceId: string;
  desktopClaim?: { botId: string; token: string };
  computerClaim?: { workspaceId: string; token: string };
  cleanupWaitMs?: number;
};

async function resolvePerBotOrphanDestroy(
  prisma: PrismaClient,
  input: OrphanCleanupInput,
): Promise<"destroy" | "skip" | "record"> {
  const claim = input.desktopClaim;
  if (!claim) return "destroy";

  const session = await prisma.desktopSession.findUnique({
    where: { botId: claim.botId },
  });
  if (!session) return "destroy";

  if (session.state === "running" && session.providerRef === input.ref.providerRef) {
    return "skip";
  }

  if (
    session.state === "booting" &&
    session.bootClaimToken &&
    session.bootClaimToken !== claim.token
  ) {
    const waited = await waitForDesktopBoot(prisma, claim.botId, {
      timeoutMs: input.cleanupWaitMs ?? DEFAULT_ORPHAN_CLEANUP_WAIT_MS,
      pollMs: DESKTOP_BOOT_POLL_MS,
    });
    if (!waited) {
      return "record";
    }
    if (waited.providerRef && waited.providerRef === input.ref.providerRef) {
      return "skip";
    }
    return "destroy";
  }

  if (
    session.state === "running" &&
    session.providerRef &&
    session.providerRef !== input.ref.providerRef
  ) {
    return "destroy";
  }

  if (session.state !== "running" || !session.providerRef) {
    return "destroy";
  }

  return "skip";
}

/**
 * Provider-aware orphan cleanup: per-bot sandboxes may destroy their own ref; shared sandboxes
 * only destroy when the DB shows the ref is not the active winner.
 */
export async function destroyOrphanProvisionIfSafe(input: OrphanCleanupInput): Promise<void> {
  const { prisma, sandbox, context, ref, kind, workspaceId } = input;
  try {
    if (isPerBotSandbox(kind)) {
      const action = await resolvePerBotOrphanDestroy(prisma, input);
      if (action === "skip") return;
      if (action === "record") {
        await recordOrphanProvisionForReconciliation(prisma, {
          ref,
          reason: "cleanup wait timeout while another boot claim active",
          workspaceId,
          botId: input.desktopClaim?.botId,
        });
        return;
      }
      await sandbox.destroy(ref, context as never);
      return;
    }

    if (!isWorkspaceScopedSandbox(kind)) return;

    const computer = await prisma.computer.findUnique({ where: { workspaceId } });
    if (!computer) return;

    const activeRef =
      computer.state === "running" && computer.providerRef ? computer.providerRef : null;

    if (activeRef && activeRef === ref.providerRef) {
      return;
    }

    const holdsComputerClaim =
      input.computerClaim &&
      computer.bootClaimToken === input.computerClaim.token &&
      (computer.state === "warming" || computer.state === "booting");

    if (holdsComputerClaim) {
      if (!activeRef || activeRef !== ref.providerRef) {
        await sandbox.destroy(ref, context as never);
      }
      return;
    }

    if (activeRef && activeRef !== ref.providerRef) {
      await sandbox.destroy(ref, context as never);
      return;
    }

    if (
      !activeRef &&
      ref.providerRef &&
      computer.providerRef &&
      computer.providerRef !== ref.providerRef
    ) {
      await sandbox.destroy(ref, context as never);
    }
  } catch {
    // Best-effort cleanup must not mask the boot failure.
  }
}
