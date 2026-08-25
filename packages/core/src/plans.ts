/**
 * SaaS plans, defined in code so limits are easy to review and edit.
 *
 * A limit of `null` means "unlimited". Never use Infinity here: these values
 * travel through zod/JSON to the web client, and Infinity does not survive
 * JSON serialization.
 */

export type PlanId = "trial" | "starter" | "pro";

export const PLAN_LIMIT_CODE = "plan_limit" as const;

export type BillingStatus = "trialing" | "active" | "past_due" | "canceled" | "incomplete";

export interface Plan {
  id: PlanId | "self-hosted";
  name: string;
  /** Maximum number of bots in the workspace. `null` = unlimited. */
  maxBots: number | null;
  /** Total tokens (input + output) per billing period. `null` = unlimited. */
  tokensPerMonth: number | null;
  /** Computer (desktop sandbox) minutes per billing period. `null` = unlimited. */
  computerMinutesPerMonth: number | null;
  /** Env var holding the Stripe Price id for this plan. `null` = not purchasable. */
  stripePriceEnv: string | null;
  /** List price in USD per month. `0` means a free trial. */
  priceUsd: number;
  /** Trial length in days, for plans that start as a trial. */
  trialDays?: number;
}

export const PLANS: Record<PlanId, Plan> = {
  trial: {
    id: "trial",
    name: "Trial",
    maxBots: 1,
    tokensPerMonth: 500_000,
    computerMinutesPerMonth: 20 * 60,
    stripePriceEnv: null,
    priceUsd: 0,
    trialDays: 7,
  },
  starter: {
    id: "starter",
    name: "Starter",
    maxBots: 3,
    tokensPerMonth: 3_000_000,
    computerMinutesPerMonth: 60 * 60,
    stripePriceEnv: "STRIPE_PRICE_STARTER",
    priceUsd: 29,
  },
  pro: {
    id: "pro",
    name: "Pro",
    maxBots: 10,
    tokensPerMonth: 15_000_000,
    computerMinutesPerMonth: 240 * 60,
    stripePriceEnv: "STRIPE_PRICE_PRO",
    priceUsd: 79,
  },
};

/** Plan reported when billing is disabled. Everything unlimited. */
export const SELF_HOSTED_PLAN: Plan = {
  id: "self-hosted",
  name: "Sem cobrança",
  maxBots: null,
  tokensPerMonth: null,
  computerMinutesPerMonth: null,
  stripePriceEnv: null,
  priceUsd: 0,
};

/** Resolves a plan id to its definition, falling back to trial for unknown ids. */
export function resolvePlan(planId: string | null | undefined): Plan {
  if (planId && planId in PLANS) return PLANS[planId as PlanId];
  return PLANS.trial;
}

/** Plans a customer can actually subscribe to. */
export function purchasablePlans(): Plan[] {
  return Object.values(PLANS).filter((plan) => plan.stripePriceEnv !== null);
}

/** Trial plus paid plans, in the order the pricing page shows them. */
export function catalogPlans(): Plan[] {
  return [PLANS.trial, ...purchasablePlans()];
}

/** The fields any plan card needs, so the API snapshot renders like `Plan`. */
export interface PlanFacts {
  maxBots: number | null;
  tokensPerMonth: number | null;
  computerMinutesPerMonth: number | null;
}

export function formatPlanPrice(plan: { priceUsd: number }): string {
  if (plan.priceUsd <= 0) return "Grátis";
  return `$${plan.priceUsd}`;
}

export function planHighlights(plan: PlanFacts): string[] {
  const bots =
    plan.maxBots === null
      ? "Bots ilimitados"
      : `${plan.maxBots} bot${plan.maxBots === 1 ? "" : "s"}`;
  const tokens =
    plan.tokensPerMonth === null
      ? "Tokens de modelo ilimitados"
      : `${formatTokenBudget(plan.tokensPerMonth)} tokens / mês`;
  const computer =
    plan.computerMinutesPerMonth === null
      ? "Tempo de computador ilimitado"
      : `${plan.computerMinutesPerMonth / 60}h de computador / mês`;
  return [bots, tokens, computer, "Suas chaves de modelo", "Memória, rotinas e log de auditoria"];
}

export function formatTokenBudget(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_000) return `${tokens / 1_000}k`;
  return String(tokens);
}

/** `12 / 20` when capped, or just the used value when the plan is unlimited. */
export function displayPlanName(snapshot: {
  enabled: boolean;
  planName: string;
  status: string;
}): string {
  if (!snapshot.enabled || snapshot.status === "self_hosted") return "Sem cobrança";
  return snapshot.planName;
}

export function isPlanLimitError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const value = error as { code?: unknown; data?: unknown; message?: unknown };
    if (
      typeof value.data === "object" &&
      value.data !== null &&
      (value.data as { code?: unknown }).code === PLAN_LIMIT_CODE
    ) {
      return true;
    }
    if (value.code === PLAN_LIMIT_CODE) return true;
    if (typeof value.message === "string") return matchesLegacyPlanError(value.message);
    return false;
  }
  return typeof error === "string" && matchesLegacyPlanError(error);
}

function matchesLegacyPlanError(message: string): boolean {
  return /trial|plano|assinatura|limite|upgrade|tokens|computador|bots|cobrança/i.test(message);
}

const PLAN_STATUS_LABELS: Record<string, string> = {
  trialing: "em trial",
  active: "ativa",
  past_due: "pagamento atrasado",
  incomplete: "pagamento pendente",
  canceled: "cancelada",
  self_hosted: "sem cobrança",
};

export function displayPlanStatus(status: string): string {
  return PLAN_STATUS_LABELS[status] ?? status.replace(/_/g, " ");
}

export function formatMeter(
  used: number,
  limit: number | null,
  format: (value: number) => string = String,
): string {
  if (limit === null) return format(used);
  return `${format(used)} / ${format(limit)}`;
}

/** `true` while `used` is strictly below the limit (or the limit is unlimited). */
export function withinLimit(used: number, limit: number | null): boolean {
  if (limit === null) return true;
  return used < limit;
}

/**
 * `true` when the subscription state itself blocks paid features:
 * canceled, past_due, or a trial past its end date.
 *
 * `incomplete` is a checkout that never confirmed (3DS, for example), not a
 * delinquency: it falls back to the trial window instead of locking the
 * workspace until Stripe expires the subscription.
 */
export function isSubscriptionBlocked(
  account: { status: string; trialEndsAt: Date | null },
  now: Date = new Date(),
): boolean {
  if (account.status === "canceled" || account.status === "past_due") return true;
  if (account.status === "trialing" || account.status === "incomplete") {
    return account.trialEndsAt !== null && account.trialEndsAt.getTime() <= now.getTime();
  }
  return false;
}

/**
 * `true` while the workspace may open a new Stripe checkout. A subscription
 * stuck in `incomplete` never charged anything, so a retry is allowed instead
 * of waiting ~23h for Stripe to expire it.
 */
export function canStartCheckout(account: {
  status: string;
  stripeSubscriptionId: string | null;
}): boolean {
  if (!account.stripeSubscriptionId) return true;
  return account.status === "incomplete";
}

/**
 * Start of the current billing period. When Stripe told us the period end we
 * count one month back from it; before the first subscription (trial) the
 * period starts when the billing account was created.
 */
export function periodStart(
  account: { currentPeriodStart?: Date | null; currentPeriodEnd: Date | null; createdAt: Date },
  now: Date = new Date(),
): Date {
  if (account.currentPeriodStart && account.currentPeriodStart.getTime() <= now.getTime()) {
    return account.currentPeriodStart;
  }
  if (account.currentPeriodEnd && account.currentPeriodEnd.getTime() > now.getTime()) {
    return oneUtcMonthBefore(account.currentPeriodEnd);
  }
  return account.createdAt;
}

/**
 * One calendar month back, in UTC, clamped to the last day of the target
 * month. `setUTCMonth(m - 1)` overflows on the 29th–31st (31/03 would become
 * 03/03), which would widen the usage window by a few days.
 */
export function oneUtcMonthBefore(date: Date): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() - 1;
  const lastDayOfTargetMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(date.getUTCDate(), lastDayOfTargetMonth),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

/** Maps a Stripe subscription status onto our closed status enum. */
export function mapStripeStatus(stripeStatus: string): BillingStatus {
  switch (stripeStatus) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    case "incomplete":
      // A first payment that never confirmed (3DS pending, for example). It is
      // not a delinquency: the customer may simply need to check out again.
      return "incomplete";
    default:
      // past_due, unpaid, paused, and anything Stripe adds later.
      return "past_due";
  }
}
