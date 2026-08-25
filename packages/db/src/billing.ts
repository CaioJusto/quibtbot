import { isSubscriptionBlocked, PLANS, periodStart, resolvePlan, withinLimit } from "@quibt/core";
import type { Prisma, PrismaClient } from "./client.js";

export type BillingCheck = "bots" | "tokens" | "computer" | "subscription";
export type BillingDbClient = PrismaClient | Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60 * 1000;

export class BillingPolicyError extends Error {
  constructor(
    readonly check: BillingCheck,
    message: string,
  ) {
    super(message);
    this.name = "BillingPolicyError";
  }
}

export async function ensureBillingAccount(
  prisma: BillingDbClient,
  workspaceId: string,
  now: Date = new Date(),
) {
  const existing = await prisma.billingAccount.findUnique({ where: { workspaceId } });
  if (existing) return existing;
  const trialDays = PLANS.trial.trialDays;
  if (!trialDays || trialDays < 1) throw new Error("The trial plan must define at least one day");
  return prisma.billingAccount.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      planId: "trial",
      status: "trialing",
      trialEndsAt: new Date(now.getTime() + trialDays * DAY_MS),
    },
    update: {},
  });
}

export async function tokensSince(
  prisma: BillingDbClient,
  workspaceId: string,
  start: Date,
): Promise<number> {
  // Only plan-paid usage consumes the quota; runs on a credential the person
  // brought (subscription sign-in or own API key) are theirs to spend.
  const sums = await prisma.usageRecord.aggregate({
    where: { workspaceId, createdAt: { gte: start }, paidBy: "plan" },
    _sum: { inputTokens: true, outputTokens: true },
  });
  return (sums._sum.inputTokens ?? 0) + (sums._sum.outputTokens ?? 0);
}

export async function assertWorkspaceWithinPlan(
  prisma: BillingDbClient,
  workspaceId: string,
  check: BillingCheck,
  now: Date = new Date(),
): Promise<void> {
  const account = await ensureBillingAccount(prisma, workspaceId, now);
  const plan = resolvePlan(account.planId);
  if (isSubscriptionBlocked(account, now)) {
    throw new BillingPolicyError(
      check,
      account.status === "trialing"
        ? "O trial acabou. Assine um plano para continuar."
        : "A assinatura não está ativa. Atualize a cobrança para continuar.",
    );
  }

  // "subscription" gates only on the Quibt subscription being active — used
  // for runs whose tokens are paid by a credential the person brought.
  if (check === "subscription") return;

  if (check === "bots") {
    const bots = await prisma.bot.count({ where: { workspaceId } });
    if (!withinLimit(bots, plan.maxBots)) {
      throw new BillingPolicyError(
        check,
        `Limite de bots: o plano ${plan.name} permite ${plan.maxBots} bot${plan.maxBots === 1 ? "" : "s"}. Faça upgrade para criar mais.`,
      );
    }
    return;
  }

  const start = periodStart(account, now);
  if (check === "tokens") {
    const tokens = await tokensSince(prisma, workspaceId, start);
    if (!withinLimit(tokens, plan.tokensPerMonth)) {
      throw new BillingPolicyError(
        check,
        `Limite mensal de tokens atingido (${plan.tokensPerMonth?.toLocaleString("pt-BR")} no plano ${plan.name}). Faça upgrade para continuar conversando.`,
      );
    }
    return;
  }

  const minutes = await computerMinutesInPeriod(prisma, workspaceId, start, now);
  if (!withinLimit(minutes, plan.computerMinutesPerMonth)) {
    const hours = plan.computerMinutesPerMonth ? plan.computerMinutesPerMonth / 60 : 0;
    throw new BillingPolicyError(
      check,
      `Limite mensal de computador atingido (${hours}h no plano ${plan.name}). Faça upgrade para mais tempo de tela.`,
    );
  }
}

/**
 * Opens a ComputerUsage interval for a bot. Any interval left open for the
 * same bot is closed first so a crashed boot can never double-count time.
 */
export async function openComputerUsage(
  prisma: PrismaClient,
  args: { workspaceId: string; botId: string },
  now: Date = new Date(),
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`computer-usage:${args.botId}`}))`;
    await closeComputerUsage(tx, args.botId, now);
    await tx.computerUsage.create({
      data: { workspaceId: args.workspaceId, botId: args.botId, startedAt: now },
    });
  });
}

/**
 * Closes every open ComputerUsage interval for a bot, stamping endedAt and
 * the elapsed milliseconds. Safe to call when nothing is open.
 */
export async function closeComputerUsage(
  prisma: BillingDbClient,
  botId: string,
  now: Date = new Date(),
): Promise<void> {
  const open = await prisma.computerUsage.findMany({
    where: { botId, endedAt: null },
    select: { id: true, startedAt: true },
  });
  for (const row of open) {
    await prisma.computerUsage.update({
      where: { id: row.id },
      data: { endedAt: now, ms: Math.max(0, now.getTime() - row.startedAt.getTime()) },
    });
  }
}

/**
 * Computer minutes consumed by a workspace since `periodStart`. Open intervals
 * count up to `now`. Intervals straddling the period start are clipped.
 */
export async function computerMinutesInPeriod(
  prisma: BillingDbClient,
  workspaceId: string,
  periodStart: Date,
  now: Date = new Date(),
): Promise<number> {
  const rows = await prisma.computerUsage.findMany({
    where: {
      workspaceId,
      OR: [{ endedAt: null }, { endedAt: { gte: periodStart } }],
    },
    select: { startedAt: true, endedAt: true },
  });
  let ms = 0;
  for (const row of rows) {
    const start = Math.max(row.startedAt.getTime(), periodStart.getTime());
    const end = row.endedAt ? row.endedAt.getTime() : now.getTime();
    if (end > start) ms += end - start;
  }
  return Math.floor(ms / 60_000);
}
