import type { AdapterContext, AgentHomeStore, SandboxProvider } from "@quibt/adapter-kit";
import type { Actor } from "@quibt/contracts";
import { appendThreadMessage, createRepos, type Prisma, type PrismaClient } from "@quibt/db";
import { finalizeBotDestroyAfterProvider } from "./bot-destroy-finalize.js";
import { computerRefFromSession } from "./computer-boot-claim.js";
import {
  cancelLifecycleCleanupIntent,
  recordLifecycleCleanupIntent,
  resolveLifecycleCleanupIntent,
} from "./lifecycle-cleanup-intent.js";
import { reconcileProviderCleanupIntent } from "./provider-cleanup-reconcile.js";
import { destroyBotSessionForRef, shouldPreserveSharedComputer } from "./sandbox-destroy.js";
import {
  claimComputerSessionStartGate,
  claimDesktopDelete,
  cleanupIntentReason,
  releaseComputerSessionStartGate,
  releaseDesktopDeleteClaim,
  startComputerSessionGateHeartbeat,
  validateComputerSessionStartGate,
  validateDesktopDeleteClaim,
} from "./session-lifecycle.js";
import {
  ACTIVE_RUN_STATUSES,
  desktopSessionProviderRef,
  isWorkspaceScopedSandbox,
  sharedComputerSiblingActivity,
} from "./workspace-computer.js";

export function confirmSpawnedBotName(confirmName: string, botName: string) {
  if (confirmName !== botName) {
    return {
      ok: false as const,
      error:
        "confirm_name must exactly match the bot's name. Refusing to delete. This is permanent — double-check before retrying.",
    };
  }
  return { ok: true as const };
}

export async function spawnBot(
  deps: {
    prisma: PrismaClient;
    wakeup?: {
      enqueue: (job: { name: string; payload: Record<string, unknown> }) => Promise<void>;
    };
    billing?: {
      assertWithinPlan(
        workspaceId: string,
        check: "tokens" | "computer" | "bots",
        tx?: Prisma.TransactionClient,
      ): Promise<void>;
    };
  },
  input: {
    spawnedBy: {
      id: string;
      name: string;
      workspaceId: string;
      userId: string;
    };
    runId: string;
    name: string;
    title?: string;
    instructions?: string;
    prompt?: string;
    /**
     * Causal webhook origin to carry into the spawned child's first run, via its
     * `webhookId` column. The run's own `trigger` always stays "spawn" — an unsupervised
     * delivery's origin survives `spawn_bot`, but the immediate cause of this particular
     * run does not change.
     */
    webhookId?: string | null;
  },
) {
  const name = input.name.trim();
  if (!name) return { error: "Bot name is required." };

  const actor: Actor = {
    userId: input.spawnedBy.userId,
    workspaceId: input.spawnedBy.workspaceId,
    workspaceRole: "member",
    email: "",
    isDeploymentOwner: false,
  };
  const existing = await deps.prisma.bot.findFirst({
    where: {
      workspaceId: input.spawnedBy.workspaceId,
      userId: input.spawnedBy.userId,
      parentBotId: input.spawnedBy.id,
      name,
    },
    include: { thread: true },
    orderBy: { createdAt: "asc" },
  });
  if (existing) {
    if (!existing.thread) throw new Error(`Spawned bot ${existing.id} is missing its thread`);
    return {
      ok: true as const,
      duplicate: true as const,
      botId: existing.id,
      name: existing.name,
      title: existing.title,
      threadId: existing.thread.id,
    };
  }
  let created: Awaited<ReturnType<ReturnType<typeof createRepos>["createBot"]>>;
  try {
    created = await createRepos(deps.prisma).createBot(
      actor,
      {
        name,
        title: (input.title ?? "").trim(),
        description: "",
        instructions: (input.instructions ?? "").trim(),
        notifyOnFinish: true,
        parentBotId: input.spawnedBy.id,
      },
      deps.billing
        ? (tx) => deps.billing!.assertWithinPlan(input.spawnedBy.workspaceId, "bots", tx)
        : undefined,
    );
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const thread = await deps.prisma.thread.findFirstOrThrow({ where: { botId: created.id } });
  await appendThreadMessage(deps.prisma, {
    threadId: thread.id,
    role: "system",
    blocks: [{ kind: "meta", text: `Criado por ${input.spawnedBy.name}` }],
    runId: input.runId,
  });

  const prompt = (input.prompt ?? "").trim();
  if (prompt) {
    await appendThreadMessage(deps.prisma, {
      threadId: thread.id,
      role: "user",
      blocks: [{ kind: "text", text: prompt }],
      runId: input.runId,
    });
    const task = await deps.prisma.task.create({
      data: {
        workspaceId: input.spawnedBy.workspaceId,
        botId: created.id,
        threadId: thread.id,
        userId: input.spawnedBy.userId,
        prompt,
        status: "queued",
      },
    });
    const run = await deps.prisma.run.create({
      data: {
        workspaceId: input.spawnedBy.workspaceId,
        botId: created.id,
        threadId: thread.id,
        taskId: task.id,
        userId: input.spawnedBy.userId,
        status: "queued",
        trigger: "spawn",
        webhookId: input.webhookId ?? undefined,
      },
    });
    await deps.wakeup?.enqueue({ name: "run.continue", payload: { runId: run.id } });
  }

  return {
    ok: true as const,
    botId: created.id,
    name: created.name,
    title: created.title,
    threadId: created.threadId,
  };
}

export async function deleteSpawnedBot(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    home: AgentHomeStore;
    dataDir?: string;
  },
  input: {
    spawnedByBotId: string;
    userId: string;
    workspaceId: string;
    confirmName: string;
    botId?: string;
  },
  context: AdapterContext,
) {
  const confirmName = input.confirmName.trim();
  if (!confirmName) {
    return { error: "confirm_name is required. Refusing to delete." };
  }

  const spawned = await deps.prisma.bot.findMany({
    where: {
      parentBotId: input.spawnedByBotId,
      userId: input.userId,
      workspaceId: input.workspaceId,
    },
  });
  const matches = input.botId
    ? spawned.filter((bot) => bot.id === input.botId)
    : spawned.filter((bot) => bot.name === confirmName);

  if (input.botId && matches.length === 0) {
    return { error: "That bot was not created by this bot. Refusing to delete." };
  }
  if (!input.botId && matches.length === 0) {
    return { error: `This bot did not create a bot named "${confirmName}". Refusing to delete.` };
  }
  if (!input.botId && matches.length > 1) {
    return {
      error: `More than one bot is named "${confirmName}". Pass bot_id as well as confirm_name.`,
    };
  }

  const target = matches[0]!;
  const confirmed = confirmSpawnedBotName(confirmName, target.name);
  if (!confirmed.ok) return confirmed;
  if (target.id === input.spawnedByBotId) {
    return { error: "A bot cannot delete itself with delete_bot." };
  }

  await destroyBot(deps, target.id, context);
  return { ok: true as const, botId: target.id, name: target.name };
}

export async function destroyBot(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    home: AgentHomeStore;
    dataDir?: string;
  },
  botId: string,
  context: AdapterContext,
) {
  const bot = await deps.prisma.bot.findUnique({
    where: { id: botId },
    include: { desktopSession: { include: { computer: true } } },
  });
  if (!bot) return;

  await deps.prisma.run.updateMany({
    where: {
      botId,
      status: { in: [...ACTIVE_RUN_STATUSES] },
    },
    data: { status: "cancelled", completedAt: new Date() },
  });

  const desktop = bot.desktopSession;
  const computer = desktop?.computer;
  const providerRef = desktop ? desktopSessionProviderRef(desktop) : undefined;
  const destroyRef =
    desktop && computer && providerRef ? computerRefFromSession(desktop) : undefined;

  const restoreState = desktop?.state ?? "stopped";
  const claim = desktop ? await claimDesktopDelete(deps.prisma, botId) : null;
  if (desktop && !claim) return;

  if (destroyRef && computer && claim) {
    const claimStatus = await validateDesktopDeleteClaim(deps.prisma, botId, claim.token);
    if (claimStatus === "reactivated") return;

    await reconcileProviderCleanupIntent(
      { prisma: deps.prisma, sandbox: deps.sandbox, home: deps.home, dataDir: deps.dataDir },
      {
        workspaceId: bot.workspaceId,
        sessionBotId: botId,
        lifecycleAction: "destroy:delete",
      },
    );

    let sessionGate: { token: string } | null = null;
    if (isWorkspaceScopedSandbox(computer.kind)) {
      sessionGate = await claimComputerSessionStartGate(deps.prisma, bot.workspaceId);
      if (!sessionGate) {
        await releaseDesktopDeleteClaim(
          deps.prisma,
          botId,
          claim.token,
          restoreState as "running" | "suspended" | "stopped" | "error",
        );
        return;
      }
    }

    await recordLifecycleCleanupIntent(deps.prisma, {
      ref: destroyRef,
      action: "destroy:delete",
      lifecycleToken: claim.token,
      sessionBotId: botId,
      workspaceId: bot.workspaceId,
      reason: cleanupIntentReason("destroy:delete"),
    });

    let finalized = false;
    try {
      const revalidated = await validateDesktopDeleteClaim(deps.prisma, botId, claim.token);
      if (revalidated !== "valid") {
        await releaseDesktopDeleteClaim(
          deps.prisma,
          botId,
          claim.token,
          restoreState as "running" | "suspended" | "stopped" | "error",
        );
        await cancelLifecycleCleanupIntent(deps.prisma, {
          workspaceId: bot.workspaceId,
          sessionBotId: botId,
          lifecycleToken: claim.token,
          lifecycleAction: "destroy:delete",
          reason: "delete claim lost before provider",
        });
        return;
      }
      if (
        sessionGate &&
        !(await validateComputerSessionStartGate(deps.prisma, bot.workspaceId, sessionGate.token))
      ) {
        await releaseDesktopDeleteClaim(
          deps.prisma,
          botId,
          claim.token,
          restoreState as "running" | "suspended" | "stopped" | "error",
        );
        await cancelLifecycleCleanupIntent(deps.prisma, {
          workspaceId: bot.workspaceId,
          sessionBotId: botId,
          lifecycleToken: claim.token,
          lifecycleAction: "destroy:delete",
          reason: "lost computer session gate before provider",
        });
        return;
      }

      const activity = await sharedComputerSiblingActivity(deps.prisma, {
        computerId: computer.id,
        workspaceId: bot.workspaceId,
        botId,
      });
      const preserveComputer = shouldPreserveSharedComputer(computer.kind, activity);

      const stopHeartbeat = sessionGate
        ? startComputerSessionGateHeartbeat(deps.prisma, bot.workspaceId, sessionGate.token)
        : undefined;
      try {
        await destroyBotSessionForRef(deps.sandbox, destroyRef, context, { preserveComputer });
      } finally {
        stopHeartbeat?.();
      }

      finalized = await finalizeBotDestroyAfterProvider(
        { prisma: deps.prisma, home: deps.home, dataDir: deps.dataDir },
        {
          botId,
          workspaceId: bot.workspaceId,
          claimToken: claim.token,
          restoreState,
          computer: { id: computer.id, kind: computer.kind },
          sessionGateToken: sessionGate?.token ?? null,
        },
      );
      if (finalized) {
        await resolveLifecycleCleanupIntent(deps.prisma, {
          workspaceId: bot.workspaceId,
          sessionBotId: botId,
          lifecycleAction: "destroy:delete",
          lifecycleToken: claim.token,
        });
      }
    } catch {
      // Lifecycle intent stays pending with token/snapshots for reconciler retry.
    } finally {
      if (sessionGate && !finalized) {
        await releaseComputerSessionStartGate(deps.prisma, bot.workspaceId, sessionGate.token);
      }
    }
    return;
  }

  if (!claim) return;
  await finalizeBotDestroyAfterProvider(
    { prisma: deps.prisma, home: deps.home, dataDir: deps.dataDir },
    {
      botId,
      workspaceId: bot.workspaceId,
      claimToken: claim.token,
      restoreState,
      computer: computer ? { id: computer.id, kind: computer.kind } : null,
    },
  );
}
