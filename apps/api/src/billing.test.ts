import { ORPCError } from "@orpc/server";
import type { Actor } from "@quibt/contracts";
import { PLANS } from "@quibt/core";
import type { PrismaClient } from "@quibt/db";
import { describe, expect, it } from "vitest";
import {
  checkoutReturnUrl,
  createBilling,
  type StripeEventLike,
  type StripeGateway,
  selfHostedSnapshot,
} from "./billing.js";

const actor: Actor = {
  userId: "user-1",
  workspaceId: "ws-1",
  workspaceRole: "owner",
  email: "owner@example.com",
  isDeploymentOwner: true,
};

interface AccountRow {
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
  updatedAt: Date;
}

/** In-memory Prisma stand-in covering exactly what the billing service touches. */
function fakePrisma(seed?: {
  account?: Partial<AccountRow>;
  bots?: number;
  tokens?: number;
  byoTokens?: number;
  computerMs?: number;
  emailVerified?: boolean;
  userExists?: boolean;
}) {
  const state = {
    accounts: [] as AccountRow[],
    events: new Set<string>(),
    bots: seed?.bots ?? 0,
    tokens: seed?.tokens ?? 0,
    byoTokens: seed?.byoTokens ?? 0,
    computerMs: seed?.computerMs ?? 0,
    emailVerified: seed?.emailVerified ?? true,
    userExists: seed?.userExists ?? true,
  };
  if (seed?.account) {
    state.accounts.push({
      id: "acct-1",
      workspaceId: "ws-1",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      planId: "trial",
      status: "trialing",
      trialEndsAt: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      checkoutPendingAt: null,
      createdAt: new Date("2026-08-01T00:00:00Z"),
      updatedAt: new Date("2026-08-01T00:00:00Z"),
      ...seed.account,
    });
  }
  const billingAccount = {
    findUnique: async ({ where }: { where: Record<string, string> }) =>
      state.accounts.find(
        (a) =>
          (where.workspaceId && a.workspaceId === where.workspaceId) ||
          (where.stripeSubscriptionId && a.stripeSubscriptionId === where.stripeSubscriptionId) ||
          (where.stripeCustomerId && a.stripeCustomerId === where.stripeCustomerId) ||
          (where.id && a.id === where.id),
      ) ?? null,
    upsert: async ({
      where,
      create,
    }: {
      where: { workspaceId: string };
      create: Partial<AccountRow>;
    }) => {
      const existing = state.accounts.find((a) => a.workspaceId === where.workspaceId);
      if (existing) return existing;
      const row: AccountRow = {
        id: `acct-${state.accounts.length + 1}`,
        workspaceId: where.workspaceId,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        planId: "trial",
        status: "trialing",
        trialEndsAt: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        checkoutPendingAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...create,
      };
      state.accounts.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<AccountRow> }) => {
      const row = state.accounts.find((a) => a.id === where.id);
      if (!row) throw new Error("not found");
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: {
        id?: string;
        workspaceId?: string;
        stripeSubscriptionId?: string | null;
        OR?: Array<{ checkoutPendingAt: null | { lt: Date } }>;
      };
      data: Partial<AccountRow>;
    }) => {
      let count = 0;
      for (const row of state.accounts) {
        const pendingMatches =
          !where.OR ||
          where.OR.some((condition) => {
            if (condition.checkoutPendingAt === null) return row.checkoutPendingAt === null;
            return (
              row.checkoutPendingAt !== null &&
              row.checkoutPendingAt < condition.checkoutPendingAt.lt
            );
          });
        if (
          (!where.id || row.id === where.id) &&
          (!where.workspaceId || row.workspaceId === where.workspaceId) &&
          (where.stripeSubscriptionId === undefined ||
            row.stripeSubscriptionId === where.stripeSubscriptionId) &&
          pendingMatches
        ) {
          Object.assign(row, data);
          count += 1;
        }
      }
      return { count };
    },
  };
  const billingEvent = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      state.events.has(where.id) ? { id: where.id } : null,
    create: async ({ data }: { data: { id: string } }) => {
      if (state.events.has(data.id)) {
        throw Object.assign(new Error("Unique constraint failed"), {
          code: "P2002",
          meta: { modelName: "BillingEvent", target: ["id"] },
        });
      }
      state.events.add(data.id);
      return data;
    },
  };
  const prisma = {
    billingAccount,
    billingEvent,
    user: {
      findUnique: async () =>
        state.userExists ? { id: actor.userId, emailVerified: state.emailVerified } : null,
    },
    bot: { count: async () => state.bots },
    usageRecord: {
      aggregate: async ({ where }: { where?: { paidBy?: string } } = {}) => ({
        _sum: {
          inputTokens: where?.paidBy === "plan" ? state.tokens : state.tokens + state.byoTokens,
          outputTokens: 0,
        },
      }),
    },
    computerUsage: {
      findMany: async () =>
        state.computerMs > 0
          ? [
              {
                startedAt: new Date(Date.now() - state.computerMs),
                endedAt: new Date(),
              },
            ]
          : [],
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };
  return { prisma: prisma as unknown as PrismaClient, state };
}

const stripeCalls: string[] = [];
let lastCheckout: Parameters<StripeGateway["createCheckoutSession"]>[0] | undefined;
const stripe: StripeGateway = {
  async createCustomer() {
    stripeCalls.push("createCustomer");
    return { id: "cus_123" };
  },
  async createCheckoutSession(params) {
    stripeCalls.push("createCheckoutSession");
    lastCheckout = params;
    return { url: `https://checkout.stripe.test/${params.priceId}` };
  },
  async createPortalSession() {
    stripeCalls.push("createPortalSession");
    return { url: "https://portal.stripe.test/session" };
  },
  async cancelSubscription(subscriptionId) {
    stripeCalls.push(`cancelSubscription:${subscriptionId}`);
  },
  async retrieveSubscription(subscriptionId) {
    return {
      id: subscriptionId,
      customer: "cus_123",
      status: "active",
      metadata: { planId: "starter" },
      items: { data: [{ price: { id: "price_starter" } }] },
    };
  },
  constructWebhookEvent() {
    throw new Error("not used in tests");
  },
};

function service(
  fake: ReturnType<typeof fakePrisma>,
  now = new Date("2026-08-13T12:00:00Z"),
  canonicalSubscription?: Record<string, unknown>,
) {
  return createBilling({
    prisma: fake.prisma,
    stripe: canonicalSubscription
      ? { ...stripe, retrieveSubscription: async () => canonicalSubscription }
      : stripe,
    webOrigin: "http://127.0.0.1:5173",
    webhookSecret: "whsec_test",
    priceEnv: { STRIPE_PRICE_STARTER: "price_starter", STRIPE_PRICE_PRO: "price_pro" },
    now: () => now,
  });
}

describe("webhook handleEvent", () => {
  const checkoutEvent: StripeEventLike = {
    id: "evt_1",
    type: "checkout.session.completed",
    data: {
      object: {
        customer: "cus_123",
        subscription: "sub_123",
        metadata: { workspaceId: "ws-1", planId: "starter" },
      },
    },
  };

  it("activates the account on checkout.session.completed", async () => {
    const fake = fakePrisma({ account: {} });
    await service(fake).handleEvent(checkoutEvent);
    const account = fake.state.accounts[0];
    expect(account.stripeCustomerId).toBe("cus_123");
    expect(account.stripeSubscriptionId).toBe("sub_123");
    expect(account.planId).toBe("starter");
    expect(account.status).toBe("active");
  });

  it("is idempotent by Stripe event id", async () => {
    const fake = fakePrisma({ account: {} });
    const billing = service(fake);
    expect(await billing.handleEvent(checkoutEvent)).toEqual({ duplicate: false });
    fake.state.accounts[0].status = "past_due";
    expect(await billing.handleEvent(checkoutEvent)).toEqual({ duplicate: true });
    expect(fake.state.accounts[0].status).toBe("past_due");
  });

  it("syncs plan, status, and period end on customer.subscription.updated", async () => {
    const fake = fakePrisma({
      account: { stripeSubscriptionId: "sub_123", planId: "starter", status: "active" },
    });
    const subscription = {
      id: "sub_123",
      customer: "cus_123",
      status: "past_due",
      metadata: {},
      items: {
        data: [
          {
            price: { id: "price_pro" },
            current_period_start: 1_757_408_000,
            current_period_end: 1_760_000_000,
          },
        ],
      },
    };
    await service(fake, undefined, subscription).handleEvent({
      id: "evt_2",
      type: "customer.subscription.updated",
      data: { object: subscription },
    });
    const account = fake.state.accounts[0];
    expect(account.planId).toBe("pro");
    expect(account.status).toBe("past_due");
    expect(account.currentPeriodStart).toEqual(new Date(1_757_408_000 * 1000));
    expect(account.currentPeriodEnd).toEqual(new Date(1_760_000_000 * 1000));
  });

  it("maps unknown Stripe statuses into the closed enum", async () => {
    const fake = fakePrisma({
      account: { stripeSubscriptionId: "sub_123", status: "active" },
    });
    const subscription = {
      id: "sub_123",
      status: "unpaid",
      metadata: {},
      items: { data: [] },
    };
    await service(fake, undefined, subscription).handleEvent({
      id: "evt_3",
      type: "customer.subscription.updated",
      data: { object: subscription },
    });
    expect(fake.state.accounts[0].status).toBe("past_due");
  });

  it("cancels the account on customer.subscription.deleted", async () => {
    const fake = fakePrisma({
      account: { stripeSubscriptionId: "sub_123", status: "active", planId: "pro" },
    });
    await service(fake, undefined, {
      id: "sub_123",
      customer: "cus_123",
      status: "canceled",
      metadata: {},
      items: { data: [] },
    }).handleEvent({
      id: "evt_4",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_123", customer: "cus_123" } },
    });
    expect(fake.state.accounts[0].status).toBe("canceled");
    expect(fake.state.accounts[0].stripeSubscriptionId).toBeNull();
  });

  it("does not reactivate a canceled account when an older update arrives later", async () => {
    const fake = fakePrisma({
      account: {
        stripeCustomerId: "cus_123",
        stripeSubscriptionId: "sub_123",
        status: "active",
      },
    });
    const canceled = {
      id: "sub_123",
      customer: "cus_123",
      status: "canceled",
      metadata: {},
      items: { data: [] },
    };
    const billing = service(fake, undefined, canceled);
    await billing.handleEvent({
      id: "evt_delete",
      type: "customer.subscription.deleted",
      data: { object: canceled },
    });
    await billing.handleEvent({
      id: "evt_old_update",
      type: "customer.subscription.updated",
      data: { object: { ...canceled, status: "active" } },
    });
    expect(fake.state.accounts[0].status).toBe("canceled");
    expect(fake.state.accounts[0].stripeSubscriptionId).toBeNull();
  });

  it("ignores an event for an old subscription after a replacement is tracked", async () => {
    const fake = fakePrisma({
      account: {
        stripeCustomerId: "cus_123",
        stripeSubscriptionId: "sub_new",
        status: "active",
        planId: "pro",
      },
    });
    await service(fake, undefined, {
      id: "sub_old",
      customer: "cus_123",
      status: "canceled",
      items: { data: [] },
    }).handleEvent({
      id: "evt_old_delete",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_old", customer: "cus_123" } },
    });
    expect(fake.state.accounts[0].stripeSubscriptionId).toBe("sub_new");
    expect(fake.state.accounts[0].status).toBe("active");
  });

  it("adopts the retry subscription when the first checkout never confirmed", async () => {
    const fake = fakePrisma({
      account: {
        stripeCustomerId: "cus_123",
        stripeSubscriptionId: "sub_incomplete",
        status: "incomplete",
      },
    });
    const retry = {
      id: "sub_retry",
      customer: "cus_123",
      status: "active",
      metadata: { planId: "starter" },
      items: { data: [{ price: { id: "price_starter" } }] },
    };
    await service(fake, undefined, retry).handleEvent({
      id: "evt_retry",
      type: "customer.subscription.created",
      data: { object: retry },
    });
    expect(fake.state.accounts[0].stripeSubscriptionId).toBe("sub_retry");
    expect(fake.state.accounts[0].status).toBe("active");
    expect(fake.state.accounts[0].planId).toBe("starter");
  });

  it("records `incomplete` instead of past_due while a payment is unconfirmed", async () => {
    const fake = fakePrisma({
      account: { stripeCustomerId: "cus_123", stripeSubscriptionId: "sub_123", status: "trialing" },
    });
    const pending = {
      id: "sub_123",
      customer: "cus_123",
      status: "incomplete",
      metadata: {},
      items: { data: [{ price: { id: "price_starter" } }] },
    };
    await service(fake, undefined, pending).handleEvent({
      id: "evt_incomplete",
      type: "customer.subscription.created",
      data: { object: pending },
    });
    expect(fake.state.accounts[0].status).toBe("incomplete");
  });

  it("stores the Stripe trial end and clears it when Stripe says there is none", async () => {
    const fake = fakePrisma({
      account: { stripeSubscriptionId: "sub_123", status: "trialing" },
    });
    const trialing = {
      id: "sub_123",
      customer: "cus_123",
      status: "trialing",
      trial_end: 1_760_000_000,
      metadata: {},
      items: { data: [{ price: { id: "price_starter" } }] },
    };
    await service(fake, undefined, trialing).handleEvent({
      id: "evt_trial",
      type: "customer.subscription.updated",
      data: { object: trialing },
    });
    expect(fake.state.accounts[0].trialEndsAt).toEqual(new Date(1_760_000_000 * 1000));

    const converted = { ...trialing, status: "active", trial_end: null };
    await service(fake, undefined, converted).handleEvent({
      id: "evt_trial_over",
      type: "customer.subscription.updated",
      data: { object: converted },
    });
    expect(fake.state.accounts[0].trialEndsAt).toBeNull();
  });

  it("leaves a local trial end alone when Stripe omits trial_end", async () => {
    const localTrialEnd = new Date("2026-08-20T12:00:00Z");
    const fake = fakePrisma({
      account: { stripeSubscriptionId: "sub_123", trialEndsAt: localTrialEnd },
    });
    const subscription = {
      id: "sub_123",
      customer: "cus_123",
      status: "active",
      metadata: {},
      items: { data: [{ price: { id: "price_starter" } }] },
    };
    await service(fake, undefined, subscription).handleEvent({
      id: "evt_no_trial_field",
      type: "customer.subscription.updated",
      data: { object: subscription },
    });
    expect(fake.state.accounts[0].trialEndsAt).toEqual(localTrialEnd);
  });

  it("marks the account past_due on invoice.payment_failed without touching the plan", async () => {
    const fake = fakePrisma({
      account: {
        stripeCustomerId: "cus_123",
        stripeSubscriptionId: "sub_123",
        status: "active",
        planId: "pro",
      },
    });
    await service(fake).handleEvent({
      id: "evt_invoice_failed",
      type: "invoice.payment_failed",
      data: { object: { customer: "cus_123", subscription: "sub_123" } },
    });
    expect(fake.state.accounts[0].status).toBe("past_due");
    expect(fake.state.accounts[0].planId).toBe("pro");
  });

  it("finds the subscription on invoices that nest it under parent", async () => {
    const fake = fakePrisma({
      account: { stripeSubscriptionId: "sub_123", status: "active", planId: "starter" },
    });
    await service(fake).handleEvent({
      id: "evt_invoice_failed_nested",
      type: "invoice.payment_failed",
      data: {
        object: {
          customer: "cus_other",
          parent: { subscription_details: { subscription: "sub_123" } },
        },
      },
    });
    expect(fake.state.accounts[0].status).toBe("past_due");
  });

  it("recovers a past_due account on invoice.paid from the canonical subscription", async () => {
    const fake = fakePrisma({
      account: {
        stripeCustomerId: "cus_123",
        stripeSubscriptionId: "sub_123",
        status: "past_due",
        planId: "starter",
      },
    });
    await service(fake, undefined, {
      id: "sub_123",
      customer: "cus_123",
      status: "active",
      metadata: {},
      items: { data: [{ price: { id: "price_starter" } }] },
    }).handleEvent({
      id: "evt_invoice_paid",
      type: "invoice.paid",
      data: { object: { customer: "cus_123", subscription: "sub_123" } },
    });
    expect(fake.state.accounts[0].status).toBe("active");
    expect(fake.state.accounts[0].planId).toBe("starter");
  });
});

describe("assertWithinPlan", () => {
  const liveTrial = { trialEndsAt: new Date("2026-08-20T00:00:00Z") };

  it("blocks bot creation at the trial limit", async () => {
    const fake = fakePrisma({ account: liveTrial, bots: 1 });
    const error = await service(fake)
      .assertWithinPlan(actor, "bots")
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({
      code: "FORBIDDEN",
      data: { code: "plan_limit" },
    });
    expect(error.message).toMatch(/Limite de bots/);
  });

  it("blocks bot creation after the trial expires even below the bot limit", async () => {
    const fake = fakePrisma({
      account: { trialEndsAt: new Date("2026-08-10T00:00:00Z") },
      bots: 0,
    });
    await expect(service(fake).assertWithinPlan(actor, "bots")).rejects.toThrow(/trial acabou/);
  });

  it("allows bot creation under the limit", async () => {
    const fake = fakePrisma({ account: liveTrial, bots: 0 });
    await expect(service(fake).assertWithinPlan(actor, "bots")).resolves.toBeUndefined();
  });

  it("blocks tokens over the monthly quota", async () => {
    const fake = fakePrisma({ account: liveTrial, tokens: 500_000 });
    await expect(service(fake).assertWithinPlan(actor, "tokens")).rejects.toThrow(
      /Limite mensal de tokens/,
    );
  });

  it("ignores tokens paid by the person's own credential", async () => {
    const fake = fakePrisma({ account: liveTrial, tokens: 0, byoTokens: 900_000 });
    await expect(service(fake).assertWithinPlan(actor, "tokens")).resolves.toBeUndefined();
  });

  it("subscription check skips the token quota but still blocks a lapsed Quibt subscription", async () => {
    const over = fakePrisma({ account: liveTrial, tokens: 500_000 });
    await expect(service(over).assertWithinPlan(actor, "subscription")).resolves.toBeUndefined();
    const lapsed = fakePrisma({ account: { status: "past_due", planId: "pro" } });
    await expect(service(lapsed).assertWithinPlan(actor, "subscription")).rejects.toThrow(
      /assinatura não está ativa/,
    );
  });

  it("blocks an expired trial with a clear message", async () => {
    const fake = fakePrisma({ account: { trialEndsAt: new Date("2026-08-10T00:00:00Z") } });
    await expect(service(fake).assertWithinPlan(actor, "tokens")).rejects.toThrow(/trial acabou/);
  });

  it("blocks past_due subscriptions", async () => {
    const fake = fakePrisma({ account: { status: "past_due", planId: "pro" } });
    await expect(service(fake).assertWithinPlan(actor, "computer")).rejects.toThrow(
      /assinatura não está ativa/,
    );
  });

  it("blocks computer time over the quota", async () => {
    const fake = fakePrisma({
      account: liveTrial,
      computerMs: 21 * 60 * 60 * 1000,
    });
    await expect(service(fake).assertWithinPlan(actor, "computer")).rejects.toThrow(
      /Limite mensal de computador/,
    );
  });

  it("lazily creates a trial billing account on first use", async () => {
    const fake = fakePrisma();
    await service(fake).assertWithinPlan(actor, "tokens");
    expect(fake.state.accounts).toHaveLength(1);
    expect(fake.state.accounts[0].planId).toBe("trial");
    expect(fake.state.accounts[0].status).toBe("trialing");
    expect(fake.state.accounts[0].trialEndsAt).toEqual(new Date("2026-08-20T12:00:00Z"));
  });
});

describe("checkout and portal", () => {
  it("creates a customer lazily and returns the checkout url", async () => {
    const fake = fakePrisma({ account: {} });
    const result = await service(fake).checkout(actor, "starter");
    expect(result.url).toBe("https://checkout.stripe.test/price_starter");
    expect(fake.state.accounts[0].stripeCustomerId).toBe("cus_123");
  });

  it("carries only the remaining whole local trial days onto checkout", async () => {
    lastCheckout = undefined;
    const fake = fakePrisma({
      account: { status: "trialing", trialEndsAt: new Date("2026-08-16T11:59:59Z") },
    });
    await service(fake).checkout(actor, "starter");
    expect(lastCheckout?.trialPeriodDays).toBe(2);
  });

  it("caps a future local trial at the catalog trial length", async () => {
    lastCheckout = undefined;
    const fake = fakePrisma({
      account: { status: "trialing", trialEndsAt: new Date("2026-09-13T12:00:00Z") },
    });
    await service(fake).checkout(actor, "starter");
    expect(lastCheckout?.trialPeriodDays).toBe(PLANS.trial.trialDays);
  });

  it("falls back to the catalog trial only when trialEndsAt is null", async () => {
    lastCheckout = undefined;
    const fake = fakePrisma({ account: { status: "trialing", trialEndsAt: null } });
    await service(fake).checkout(actor, "starter");
    expect(lastCheckout?.trialPeriodDays).toBe(PLANS.trial.trialDays);
  });

  it("omits the Stripe trial when less than one whole day remains", async () => {
    lastCheckout = undefined;
    const fake = fakePrisma({
      account: { status: "trialing", trialEndsAt: new Date("2026-08-14T11:59:59Z") },
    });
    await service(fake).checkout(actor, "starter");
    expect(lastCheckout?.trialPeriodDays).toBeUndefined();
  });

  it("does not re-grant a trial once the account is active", async () => {
    lastCheckout = undefined;
    const fake = fakePrisma({ account: { status: "active" } });
    await service(fake).checkout(actor, "pro");
    expect(lastCheckout?.trialPeriodDays).toBeUndefined();
  });

  it("refuses to charge a card before the e-mail is confirmed", async () => {
    const fake = fakePrisma({ account: {}, emailVerified: false });
    await expect(service(fake).checkout(actor, "starter")).rejects.toThrow(/Confirme seu e-mail/);
    // The checkout claim must not be left hanging on the account.
    expect(fake.state.accounts[0].checkoutPendingAt).toBeNull();
  });

  it("refuses checkout when the authenticated user row is missing", async () => {
    const fake = fakePrisma({ account: {}, userExists: false });
    await expect(service(fake).checkout(actor, "starter")).rejects.toThrow(/validar sua conta/);
    expect(fake.state.accounts[0].checkoutPendingAt).toBeNull();
  });

  it("rejects unknown plans", async () => {
    const fake = fakePrisma({ account: {} });
    await expect(service(fake).checkout(actor, "enterprise")).rejects.toThrow(ORPCError);
  });

  it("rejects the trial plan (not purchasable)", async () => {
    const fake = fakePrisma({ account: {} });
    await expect(service(fake).checkout(actor, "trial")).rejects.toThrow(ORPCError);
  });

  it("rejects a second subscription and concurrent checkout attempts", async () => {
    const subscribed = fakePrisma({ account: { stripeSubscriptionId: "sub_123" } });
    await expect(service(subscribed).checkout(actor, "starter")).rejects.toThrow(
      /Já existe uma assinatura/,
    );

    const pending = fakePrisma({
      account: { checkoutPendingAt: new Date("2026-08-13T11:59:00Z") },
    });
    await expect(service(pending).checkout(actor, "starter")).rejects.toThrow(
      /Já existe um checkout em andamento/,
    );
  });

  it("lets a checkout stuck in `incomplete` be retried instead of locking the workspace", async () => {
    const stuck = fakePrisma({
      account: { stripeSubscriptionId: "sub_incomplete", status: "incomplete" },
    });
    const result = await service(stuck).checkout(actor, "starter");
    expect(result.url).toBe("https://checkout.stripe.test/price_starter");
    expect(stuck.state.accounts[0].checkoutPendingAt).not.toBeNull();
  });

  it("requires an existing customer for the portal", async () => {
    const fake = fakePrisma({ account: {} });
    await expect(service(fake).portal(actor)).rejects.toThrow(/Ainda não há cliente de cobrança/);
    fake.state.accounts[0].stripeCustomerId = "cus_123";
    await expect(service(fake).portal(actor)).resolves.toEqual({
      url: "https://portal.stripe.test/session",
    });
  });
});

describe("billing disabled (self-host)", () => {
  it("reports an unlimited self-hosted plan", async () => {
    const fake = fakePrisma({ bots: 7 });
    const snap = await selfHostedSnapshot(fake.prisma, actor);
    expect(snap.enabled).toBe(false);
    expect(snap.planId).toBe("self-hosted");
    expect(snap.status).toBe("self_hosted");
    expect(snap.limits).toEqual({
      maxBots: null,
      tokensPerMonth: null,
      computerMinutesPerMonth: null,
    });
    expect(snap.usage.bots).toBe(7);
    expect(snap.plans.map((plan) => plan.priceUsd)).toEqual([0, 29, 79]);
  });
});

describe("billing snapshot (enabled)", () => {
  it("returns plan, usage, and purchasable plans", async () => {
    const fake = fakePrisma({
      account: { planId: "starter", status: "active" },
      bots: 2,
      tokens: 1_000,
      computerMs: 30 * 60_000,
    });
    const snap = await service(fake).snapshot(actor);
    expect(snap.enabled).toBe(true);
    expect(snap.planId).toBe("starter");
    expect(snap.status).toBe("active");
    expect(snap.usage).toEqual({ tokens: 1_000, computerMinutes: 30, bots: 2 });
    expect(snap.limits.maxBots).toBe(3);
    expect(snap.plans.map((p) => p.id)).toEqual(["trial", "starter", "pro"]);
    expect(snap.plans.map((p) => p.priceUsd)).toEqual([
      PLANS.trial.priceUsd,
      PLANS.starter.priceUsd,
      PLANS.pro.priceUsd,
    ]);
  });
});

describe("checkoutReturnUrl", () => {
  it("keeps same-origin https URLs and rejects everything else", () => {
    expect(
      checkoutReturnUrl(
        "https://app.example.com/billing?app=1",
        "https://app.example.com/billing",
        "https://app.example.com",
      ),
    ).toBe("https://app.example.com/billing?app=1");
    expect(
      checkoutReturnUrl(
        "https://evil.example/phish",
        "https://app.example.com/billing",
        "https://app.example.com",
      ),
    ).toBe("https://app.example.com/billing");
    expect(
      checkoutReturnUrl(
        "javascript:alert(1)",
        "https://app.example.com/billing",
        "https://app.example.com",
      ),
    ).toBe("https://app.example.com/billing");
    expect(
      checkoutReturnUrl(
        "https://user@app.example.com/billing",
        "https://app.example.com/billing",
        "https://app.example.com",
      ),
    ).toBe("https://app.example.com/billing");
    expect(
      checkoutReturnUrl(
        "http://app.example.com/billing",
        "https://app.example.com/billing",
        "https://app.example.com",
      ),
    ).toBe("https://app.example.com/billing");
  });
});
