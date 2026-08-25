import { ORPCError } from "@orpc/server";
import type { Actor, BillingSnapshot } from "@quibt/contracts";
import {
  canStartCheckout,
  catalogPlans,
  mapStripeStatus,
  PLAN_LIMIT_CODE,
  PLANS,
  type Plan,
  periodStart,
  purchasablePlans,
  resolvePlan,
  SELF_HOSTED_PLAN,
} from "@quibt/core";
import {
  assertWorkspaceWithinPlan,
  type BillingDbClient,
  BillingPolicyError,
  computerMinutesInPeriod,
  ensureBillingAccount,
  type Prisma,
  type PrismaClient,
  tokensSince,
} from "@quibt/db";
import Stripe from "stripe";

// ── Stripe gateway ───────────────────────────────────────────────────────────
// The service talks to this narrow surface so tests can pass a fake with no
// network. `createStripeGateway` adapts the real SDK to it.

export interface StripeEventLike {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export interface StripeGateway {
  createCustomer(params: {
    email?: string;
    name?: string;
    metadata?: Record<string, string>;
  }): Promise<{ id: string }>;
  createCheckoutSession(params: {
    customer: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
    /** Carries the local trial onto the card, on the first paid checkout only. */
    trialPeriodDays?: number;
  }): Promise<{ url: string | null }>;
  createPortalSession(params: { customer: string; returnUrl: string }): Promise<{ url: string }>;
  cancelSubscription(subscriptionId: string): Promise<void>;
  retrieveSubscription(subscriptionId: string): Promise<Record<string, unknown>>;
  constructWebhookEvent(payload: string, signature: string, secret: string): StripeEventLike;
}

export function createStripeGateway(secretKey: string): StripeGateway {
  const stripe = new Stripe(secretKey, { maxNetworkRetries: 2 });
  return {
    async createCustomer(params) {
      const customer = await stripe.customers.create({
        email: params.email,
        name: params.name,
        metadata: params.metadata,
      });
      return { id: customer.id };
    },
    async createCheckoutSession(params) {
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: params.customer,
        line_items: [{ price: params.priceId, quantity: 1 }],
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        client_reference_id: params.metadata.workspaceId,
        metadata: params.metadata,
        subscription_data: {
          metadata: params.metadata,
          ...(params.trialPeriodDays ? { trial_period_days: params.trialPeriodDays } : {}),
        },
      });
      return { url: session.url };
    },
    async createPortalSession(params) {
      const session = await stripe.billingPortal.sessions.create({
        customer: params.customer,
        return_url: params.returnUrl,
      });
      return { url: session.url };
    },
    async cancelSubscription(subscriptionId) {
      await stripe.subscriptions.cancel(subscriptionId);
    },
    async retrieveSubscription(subscriptionId) {
      return stripe.subscriptions.retrieve(subscriptionId) as unknown as Record<string, unknown>;
    },
    constructWebhookEvent(payload, signature, secret) {
      return stripe.webhooks.constructEvent(
        payload,
        signature,
        secret,
      ) as unknown as StripeEventLike;
    },
  };
}

// ── Service ──────────────────────────────────────────────────────────────────

export interface BillingDeps {
  prisma: PrismaClient;
  stripe: StripeGateway;
  webOrigin: string;
  webhookSecret?: string;
  /** Where STRIPE_PRICE_* variables live. Defaults to process.env. */
  priceEnv?: Record<string, string | undefined>;
  now?: () => Date;
}

export type PlanCheck = "bots" | "tokens" | "computer";

export interface BillingService {
  snapshot(actor: Actor): Promise<BillingSnapshot>;
  checkout(
    actor: Actor,
    planId: string,
    urls?: { successUrl?: string; cancelUrl?: string },
  ): Promise<{ url: string }>;
  portal(actor: Actor): Promise<{ url: string }>;
  cancelSubscription(subscriptionId: string): Promise<void>;
  assertWithinPlan(actor: Actor, check: PlanCheck, prisma?: BillingDbClient): Promise<void>;
  verifyWebhook(payload: string, signature: string): StripeEventLike;
  handleEvent(event: StripeEventLike): Promise<{ duplicate: boolean }>;
}

interface BillingAccountRow {
  id: string;
  workspaceId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  planId: string;
  status: string;
  trialEndsAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  checkoutPendingAt: Date | null;
  createdAt: Date;
}

export function createBilling(deps: BillingDeps): BillingService {
  const now = deps.now ?? (() => new Date());
  const priceEnv = deps.priceEnv ?? process.env;

  async function ensureAccount(workspaceId: string): Promise<BillingAccountRow> {
    return ensureBillingAccount(deps.prisma, workspaceId, now());
  }

  async function usageFor(account: BillingAccountRow, workspaceId: string) {
    const at = now();
    const start = periodStart(account, at);
    const [tokens, computerMinutes, bots] = await Promise.all([
      tokensSince(deps.prisma, workspaceId, start),
      computerMinutesInPeriod(deps.prisma, workspaceId, start, at),
      deps.prisma.bot.count({ where: { workspaceId } }),
    ]);
    return { tokens, computerMinutes, bots };
  }

  function priceIdFor(plan: Plan): string | undefined {
    return plan.stripePriceEnv ? priceEnv[plan.stripePriceEnv] : undefined;
  }

  async function applyEvent(
    tx: Prisma.TransactionClient,
    event: StripeEventLike,
    currentSubscription?: Record<string, unknown>,
  ): Promise<void> {
    const object = event.data.object;
    switch (event.type) {
      case "checkout.session.completed": {
        const metadata = (object.metadata ?? {}) as Record<string, string>;
        const workspaceId = metadata.workspaceId;
        if (!workspaceId) return;
        const account = await tx.billingAccount.findUnique({ where: { workspaceId } });
        if (!account) return;
        const subscriptionId = asId(object.subscription);
        if (ignoresForeignSubscription(account, subscriptionId)) return;
        if (currentSubscription) {
          await applySubscription(
            tx,
            account,
            currentSubscription,
            priceEnv,
            asId(object.customer),
          );
        } else {
          await tx.billingAccount.update({
            where: { id: account.id },
            data: {
              stripeCustomerId: asId(object.customer) ?? account.stripeCustomerId,
              checkoutPendingAt: null,
            },
          });
        }
        return;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscriptionId = asId(object.id);
        const customerId = asId(object.customer);
        if (!subscriptionId && !customerId) return;
        const account = await findAccountForSubscription(tx, subscriptionId, customerId);
        if (!account) return;
        if (ignoresForeignSubscription(account, subscriptionId)) return;
        const canonical = currentSubscription ?? object;
        await applySubscription(
          tx,
          account,
          event.type === "customer.subscription.deleted"
            ? { ...canonical, status: "canceled" }
            : canonical,
          priceEnv,
          customerId,
        );
        return;
      }
      case "invoice.payment_failed": {
        const account = await findAccountForSubscription(
          tx,
          invoiceSubscriptionId(object),
          asId(object.customer),
        );
        if (!account) return;
        // The plan stays; only the state changes. `isSubscriptionBlocked`
        // already treats past_due as blocked.
        await tx.billingAccount.update({
          where: { id: account.id },
          data: { status: "past_due", checkoutPendingAt: null },
        });
        return;
      }
      case "invoice.paid": {
        // Recovery is only believable from the subscription itself, so this
        // does nothing unless Stripe handed us the canonical object.
        if (!currentSubscription) return;
        const account = await findAccountForSubscription(
          tx,
          invoiceSubscriptionId(object),
          asId(object.customer),
        );
        if (!account) return;
        await applySubscription(tx, account, currentSubscription, priceEnv, asId(object.customer));
        return;
      }
      default:
        return;
    }
  }

  return {
    async snapshot(actor) {
      const account = await ensureAccount(actor.workspaceId);
      const plan = resolvePlan(account.planId);
      const usage = await usageFor(account, actor.workspaceId);
      return {
        enabled: true,
        planId: plan.id,
        planName: plan.name,
        status: account.status as BillingSnapshot["status"],
        trialEndsAt: account.trialEndsAt?.toISOString() ?? null,
        currentPeriodEnd: account.currentPeriodEnd?.toISOString() ?? null,
        usage,
        limits: planLimits(plan),
        plans: snapshotPlans(),
      };
    },

    async checkout(actor, planId, urls) {
      const plan = (PLANS as Record<string, Plan>)[planId];
      if (!plan?.stripePriceEnv) {
        throw new ORPCError("BAD_REQUEST", {
          message: `Plano desconhecido ou sem cobrança: ${planId}`,
        });
      }
      const priceId = priceIdFor(plan);
      if (!priceId) {
        throw new ORPCError("BAD_REQUEST", {
          message: `O preço Stripe do plano "${planId}" não está configurado (${plan.stripePriceEnv}).`,
        });
      }
      // Paying for a mailbox nobody confirmed means no receipts, no password
      // reset, and a dispute we cannot answer. Only the paid path demands it —
      // self-hosted deploys never reach here.
      const user = await deps.prisma.user.findUnique({
        where: { id: actor.userId },
        select: { emailVerified: true },
      });
      if (!user) {
        throw new ORPCError("FORBIDDEN", {
          message:
            "Não foi possível validar sua conta para o checkout. Entre novamente e tente de novo.",
        });
      }
      if (!user.emailVerified) {
        throw new ORPCError("FORBIDDEN", {
          message:
            "Confirme seu e-mail antes de assinar. Reenvie a verificação em Sua conta e tente de novo.",
        });
      }
      const account = await ensureAccount(actor.workspaceId);
      if (!canStartCheckout(account)) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Já existe uma assinatura. Use o portal de cobrança para mudar de plano.",
        });
      }
      // A subscription stuck in `incomplete` (3DS never confirmed) charged
      // nothing, so the claim must not require an empty stripeSubscriptionId.
      const subscriptionClaimWhere = account.stripeSubscriptionId
        ? {}
        : { stripeSubscriptionId: null };
      const pendingBefore = new Date(now().getTime() - 30 * 60_000);
      const claimed = await deps.prisma.billingAccount.updateMany({
        where: {
          id: account.id,
          ...subscriptionClaimWhere,
          OR: [{ checkoutPendingAt: null }, { checkoutPendingAt: { lt: pendingBefore } }],
        },
        data: { checkoutPendingAt: now() },
      });
      if (claimed.count !== 1) {
        throw new ORPCError("CONFLICT", {
          message:
            "Já existe um checkout em andamento. Conclua ou tente de novo em alguns minutos.",
        });
      }
      let customerId = account.stripeCustomerId;
      try {
        if (!customerId) {
          const customer = await deps.stripe.createCustomer({
            email: actor.email,
            metadata: { workspaceId: actor.workspaceId },
          });
          customerId = customer.id;
          await deps.prisma.billingAccount.update({
            where: { id: account.id },
            data: { stripeCustomerId: customerId },
          });
        }
        const session = await deps.stripe.createCheckoutSession({
          customer: customerId,
          priceId,
          successUrl: checkoutReturnUrl(
            urls?.successUrl,
            `${deps.webOrigin}/billing?billing=success`,
            deps.webOrigin,
          ),
          cancelUrl: checkoutReturnUrl(
            urls?.cancelUrl,
            `${deps.webOrigin}/billing?billing=canceled`,
            deps.webOrigin,
          ),
          metadata: { workspaceId: actor.workspaceId, planId: plan.id },
          trialPeriodDays: checkoutTrialDays(account, now()),
        });
        if (!session.url) {
          throw new ORPCError("INTERNAL_SERVER_ERROR", {
            message: "O Stripe não devolveu uma URL de checkout.",
          });
        }
        return { url: session.url };
      } catch (error) {
        await deps.prisma.billingAccount.updateMany({
          where: { id: account.id, ...subscriptionClaimWhere },
          data: { checkoutPendingAt: null },
        });
        throw error;
      }
    },

    async portal(actor) {
      const account = await ensureAccount(actor.workspaceId);
      if (!account.stripeCustomerId) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Ainda não há cliente de cobrança. Assine um plano primeiro.",
        });
      }
      const session = await deps.stripe.createPortalSession({
        customer: account.stripeCustomerId,
        returnUrl: `${deps.webOrigin}/billing`,
      });
      return { url: session.url };
    },

    async cancelSubscription(subscriptionId) {
      await deps.stripe.cancelSubscription(subscriptionId);
    },

    async assertWithinPlan(actor, check, prisma = deps.prisma) {
      try {
        await assertWorkspaceWithinPlan(prisma, actor.workspaceId, check, now());
      } catch (error) {
        if (error instanceof BillingPolicyError) {
          throw new ORPCError("FORBIDDEN", {
            message: error.message,
            data: { code: PLAN_LIMIT_CODE },
          });
        }
        throw error;
      }
    },

    verifyWebhook(payload, signature) {
      if (!deps.webhookSecret) {
        throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
      }
      return deps.stripe.constructWebhookEvent(payload, signature, deps.webhookSecret);
    },

    async handleEvent(event) {
      const seen = await deps.prisma.billingEvent.findUnique({ where: { id: event.id } });
      if (seen) return { duplicate: true };
      const subscriptionId = eventSubscriptionId(event);
      const currentSubscription = subscriptionId
        ? await deps.stripe.retrieveSubscription(subscriptionId)
        : undefined;
      try {
        await deps.prisma.$transaction(async (tx) => {
          await tx.billingEvent.create({ data: { id: event.id, type: event.type } });
          await applyEvent(tx, event, currentSubscription);
        });
        return { duplicate: false };
      } catch (error) {
        if (isUniqueViolation(error)) return { duplicate: true };
        throw error;
      }
    },
  };
}

// ── Self-hosted (billing disabled) ───────────────────────────────────────────

export async function selfHostedSnapshot(
  prisma: PrismaClient,
  actor: Actor,
): Promise<BillingSnapshot> {
  const bots = await prisma.bot.count({ where: { workspaceId: actor.workspaceId } });
  return {
    enabled: false,
    planId: SELF_HOSTED_PLAN.id,
    planName: SELF_HOSTED_PLAN.name,
    status: "self_hosted",
    trialEndsAt: null,
    currentPeriodEnd: null,
    usage: { tokens: 0, computerMinutes: 0, bots },
    limits: planLimits(SELF_HOSTED_PLAN),
    plans: snapshotPlans(),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function checkoutReturnUrl(
  requested: string | undefined,
  fallback: string,
  webOrigin: string,
): string {
  if (!requested) return fallback;
  try {
    const url = new URL(requested);
    const allowed = new URL(webOrigin);
    if (url.username || url.password) return fallback;
    if (url.origin === allowed.origin && url.protocol.startsWith("http")) return requested;
  } catch {
    return fallback;
  }
  return fallback;
}

/**
 * The trial is a local plan, not a Stripe product. When someone upgrades while
 * still inside it, the first paid checkout carries only the whole local days
 * that remain. Stripe never receives more trial than the catalog permits.
 */
export function checkoutTrialDays(
  account: {
    status: string;
    stripeSubscriptionId: string | null;
    trialEndsAt: Date | null;
  },
  now: Date = new Date(),
): number | undefined {
  if (account.status !== "trialing" || account.stripeSubscriptionId) return undefined;
  const maximum = PLANS.trial.trialDays;
  if (!maximum || maximum < 1) return undefined;
  if (account.trialEndsAt === null) return maximum;
  const wholeDays = Math.floor((account.trialEndsAt.getTime() - now.getTime()) / 86_400_000);
  if (wholeDays < 1) return undefined;
  return Math.min(wholeDays, maximum);
}

function planLimits(plan: Plan) {
  return {
    maxBots: plan.maxBots,
    tokensPerMonth: plan.tokensPerMonth,
    computerMinutesPerMonth: plan.computerMinutesPerMonth,
  };
}

function snapshotPlans() {
  return catalogPlans().map((plan) => ({
    id: plan.id,
    name: plan.name,
    priceUsd: plan.priceUsd,
    ...planLimits(plan),
  }));
}

/**
 * `true` quando o evento é de outra assinatura e deve ser ignorado. A conta só
 * troca de assinatura quando a que está gravada nunca chegou a valer
 * (`incomplete`) — é o segundo checkout, permitido depois de um 3DS travado,
 * assumindo a conta.
 */
export function ignoresForeignSubscription(
  account: { status?: string | null; stripeSubscriptionId: string | null },
  subscriptionId: string | undefined,
): boolean {
  if (!account.stripeSubscriptionId || !subscriptionId) return false;
  if (account.stripeSubscriptionId === subscriptionId) return false;
  return account.status !== "incomplete";
}

async function findAccountForSubscription(
  tx: Prisma.TransactionClient,
  subscriptionId: string | undefined,
  customerId: string | undefined,
): Promise<{
  id: string;
  status: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
} | null> {
  if (subscriptionId) {
    const bySub = await tx.billingAccount.findUnique({
      where: { stripeSubscriptionId: subscriptionId },
    });
    if (bySub) return bySub;
  }
  if (customerId) {
    return tx.billingAccount.findUnique({ where: { stripeCustomerId: customerId } });
  }
  return null;
}

async function applySubscription(
  tx: Prisma.TransactionClient,
  account: {
    id: string;
    status?: string | null;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
  },
  subscription: Record<string, unknown>,
  priceEnv: Record<string, string | undefined>,
  fallbackCustomerId?: string,
): Promise<void> {
  const subscriptionId = asId(subscription.id);
  if (ignoresForeignSubscription(account, subscriptionId)) return;
  const metadata = (subscription.metadata ?? {}) as Record<string, string>;
  const plan =
    planForSubscription(subscription, priceEnv) ??
    (metadata.planId ? (PLANS as Record<string, Plan>)[metadata.planId] : undefined);
  const status = mapStripeStatus(String(subscription.status ?? "incomplete"));
  const ended = status === "canceled";
  const periodEnd = subscriptionPeriodEnd(subscription);
  const periodStart = subscriptionPeriodStart(subscription);
  const trialEnd = subscriptionTrialEnd(subscription);
  await tx.billingAccount.update({
    where: { id: account.id },
    data: {
      stripeSubscriptionId: ended ? null : (subscriptionId ?? account.stripeSubscriptionId),
      stripeCustomerId:
        asId(subscription.customer) ?? fallbackCustomerId ?? account.stripeCustomerId,
      status,
      checkoutPendingAt: null,
      ...(plan ? { planId: plan.id } : {}),
      ...(periodStart ? { currentPeriodStart: periodStart } : {}),
      ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
      ...(trialEnd === undefined ? {} : { trialEndsAt: trialEnd }),
    },
  });
}

/**
 * Stripe's `trial_end`, in unix seconds. `undefined` means the field was absent
 * and the stored value must stay put; `null` means Stripe told us there is no
 * trial anymore, which does clear it.
 */
export function subscriptionTrialEnd(
  subscription: Record<string, unknown>,
): Date | null | undefined {
  if (!("trial_end" in subscription)) return undefined;
  const raw = subscription.trial_end;
  if (typeof raw === "number" && raw > 0) return new Date(raw * 1000);
  if (raw === null || raw === 0) return null;
  return undefined;
}

function eventSubscriptionId(event: StripeEventLike): string | undefined {
  if (event.type === "checkout.session.completed") return asId(event.data.object.subscription);
  if (event.type.startsWith("customer.subscription.")) return asId(event.data.object.id);
  if (event.type.startsWith("invoice.")) return invoiceSubscriptionId(event.data.object);
  return undefined;
}

/**
 * Older Stripe API versions put `subscription` on the invoice; current ones
 * moved it under `parent.subscription_details`. Both spots are checked.
 */
export function invoiceSubscriptionId(invoice: Record<string, unknown>): string | undefined {
  const direct = asId(invoice.subscription);
  if (direct) return direct;
  const parent = invoice.parent as
    | { subscription_details?: { subscription?: unknown } }
    | undefined;
  return asId(parent?.subscription_details?.subscription);
}

function planForSubscription(
  subscription: Record<string, unknown>,
  priceEnv: Record<string, string | undefined>,
): Plan | undefined {
  const priceId = subscriptionPriceId(subscription);
  if (!priceId) return undefined;
  return purchasablePlans().find((plan) => {
    if (!plan.stripePriceEnv) return false;
    return priceEnv[plan.stripePriceEnv] === priceId;
  });
}

/**
 * Reads the current period end off a subscription object. On current Stripe
 * API versions the field lives on the subscription items; older versions had
 * it on the subscription itself, so both spots are checked.
 */
function subscriptionPeriodEnd(subscription: Record<string, unknown>): Date | undefined {
  const items = subscription.items as { data?: Array<{ current_period_end?: number }> } | undefined;
  const fromItems = items?.data
    ?.map((item) => item.current_period_end ?? 0)
    .reduce((a, b) => Math.max(a, b), 0);
  const raw = fromItems || (subscription.current_period_end as number | undefined);
  return raw ? new Date(raw * 1000) : undefined;
}

function subscriptionPeriodStart(subscription: Record<string, unknown>): Date | undefined {
  const items = subscription.items as
    | { data?: Array<{ current_period_start?: number }> }
    | undefined;
  const fromItems = items?.data
    ?.map((item) => item.current_period_start ?? 0)
    .filter((value) => value > 0)
    .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
  const raw =
    fromItems && Number.isFinite(fromItems)
      ? fromItems
      : (subscription.current_period_start as number | undefined);
  return raw ? new Date(raw * 1000) : undefined;
}

function subscriptionPriceId(subscription: Record<string, unknown>): string | undefined {
  const items = subscription.items as { data?: Array<{ price?: { id?: string } }> } | undefined;
  return items?.data?.[0]?.price?.id;
}

function asId(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const candidate = error as {
    code?: string;
    meta?: { modelName?: string; target?: string[] | string };
  };
  const target = Array.isArray(candidate.meta?.target)
    ? candidate.meta.target
    : [candidate.meta?.target];
  return (
    candidate.code === "P2002" &&
    candidate.meta?.modelName === "BillingEvent" &&
    target.some((field) => field === "id")
  );
}
