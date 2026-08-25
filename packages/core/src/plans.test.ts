import { describe, expect, it } from "vitest";
import {
  canStartCheckout,
  catalogPlans,
  displayPlanName,
  displayPlanStatus,
  formatMeter,
  formatPlanPrice,
  formatTokenBudget,
  isPlanLimitError,
  isSubscriptionBlocked,
  mapStripeStatus,
  PLAN_LIMIT_CODE,
  PLANS,
  periodStart,
  planHighlights,
  purchasablePlans,
  resolvePlan,
  SELF_HOSTED_PLAN,
  withinLimit,
} from "./plans.js";

describe("resolvePlan", () => {
  it("resolves known plans", () => {
    expect(resolvePlan("starter")).toBe(PLANS.starter);
    expect(resolvePlan("pro")).toBe(PLANS.pro);
    expect(resolvePlan("trial")).toBe(PLANS.trial);
  });

  it("falls back to trial for unknown or missing ids", () => {
    expect(resolvePlan("enterprise")).toBe(PLANS.trial);
    expect(resolvePlan(null)).toBe(PLANS.trial);
    expect(resolvePlan(undefined)).toBe(PLANS.trial);
  });
});

describe("catalogPlans", () => {
  it("shows trial then paid plans with list prices", () => {
    expect(catalogPlans().map((plan) => plan.id)).toEqual(["trial", "starter", "pro"]);
    expect(formatPlanPrice(PLANS.trial)).toBe("Grátis");
    expect(formatPlanPrice(PLANS.starter)).toBe("$29");
    expect(planHighlights(PLANS.trial)[0]).toBe("1 bot");
  });

  /**
   * The one place the ladder is defined. Web, mobile onboarding, and the
   * landing page all derive from here — if these numbers move without the
   * marketing copy moving with them, this is what breaks first.
   */
  it("pins the advertised ladder: bots, tokens, computer hours, price", () => {
    expect(
      catalogPlans().map((plan) => [
        plan.id,
        plan.maxBots,
        plan.tokensPerMonth,
        plan.computerMinutesPerMonth === null ? null : plan.computerMinutesPerMonth / 60,
        plan.priceUsd,
      ]),
    ).toEqual([
      ["trial", 1, 500_000, 20, 0],
      ["starter", 3, 3_000_000, 60, 29],
      ["pro", 10, 15_000_000, 240, 79],
    ]);
    expect(PLANS.trial.trialDays).toBe(7);
    expect(catalogPlans().map((plan) => planHighlights(plan).slice(0, 3))).toEqual([
      ["1 bot", "500k tokens / mês", "20h de computador / mês"],
      ["3 bots", "3M tokens / mês", "60h de computador / mês"],
      ["10 bots", "15M tokens / mês", "240h de computador / mês"],
    ]);
  });
});

describe("purchasablePlans", () => {
  it("only returns plans with a Stripe price env", () => {
    const plans = purchasablePlans();
    expect(plans.map((p) => p.id)).toEqual(["starter", "pro"]);
    for (const plan of plans) expect(plan.stripePriceEnv).toMatch(/^STRIPE_PRICE_/);
  });
});

describe("withinLimit", () => {
  it("treats null as unlimited", () => {
    expect(withinLimit(Number.MAX_SAFE_INTEGER, null)).toBe(true);
  });

  it("blocks at the limit boundary", () => {
    expect(withinLimit(499_999, 500_000)).toBe(true);
    expect(withinLimit(500_000, 500_000)).toBe(false);
    expect(withinLimit(500_001, 500_000)).toBe(false);
  });

  it("self-hosted plan is unlimited everywhere", () => {
    expect(withinLimit(10_000_000, SELF_HOSTED_PLAN.tokensPerMonth)).toBe(true);
    expect(withinLimit(1_000, SELF_HOSTED_PLAN.maxBots)).toBe(true);
    expect(withinLimit(100_000, SELF_HOSTED_PLAN.computerMinutesPerMonth)).toBe(true);
  });
});

describe("isSubscriptionBlocked", () => {
  const now = new Date("2026-08-13T12:00:00Z");

  it("blocks canceled and past_due", () => {
    expect(isSubscriptionBlocked({ status: "canceled", trialEndsAt: null }, now)).toBe(true);
    expect(isSubscriptionBlocked({ status: "past_due", trialEndsAt: null }, now)).toBe(true);
  });

  it("allows active", () => {
    expect(isSubscriptionBlocked({ status: "active", trialEndsAt: null }, now)).toBe(false);
  });

  it("does not lock the workspace on an unconfirmed (incomplete) checkout", () => {
    const future = new Date("2026-08-20T12:00:00Z");
    expect(isSubscriptionBlocked({ status: "incomplete", trialEndsAt: future }, now)).toBe(false);
    expect(isSubscriptionBlocked({ status: "incomplete", trialEndsAt: null }, now)).toBe(false);
    const past = new Date("2026-08-10T12:00:00Z");
    expect(isSubscriptionBlocked({ status: "incomplete", trialEndsAt: past }, now)).toBe(true);
  });

  it("allows a live trial and blocks an expired one", () => {
    const future = new Date("2026-08-20T12:00:00Z");
    const past = new Date("2026-08-10T12:00:00Z");
    expect(isSubscriptionBlocked({ status: "trialing", trialEndsAt: future }, now)).toBe(false);
    expect(isSubscriptionBlocked({ status: "trialing", trialEndsAt: past }, now)).toBe(true);
    expect(isSubscriptionBlocked({ status: "trialing", trialEndsAt: null }, now)).toBe(false);
  });
});

describe("periodStart", () => {
  const now = new Date("2026-08-13T12:00:00Z");
  const createdAt = new Date("2026-08-01T00:00:00Z");

  it("counts one month back from a future currentPeriodEnd", () => {
    const end = new Date("2026-09-05T00:00:00Z");
    expect(periodStart({ currentPeriodEnd: end, createdAt }, now).toISOString()).toBe(
      "2026-08-05T00:00:00.000Z",
    );
  });

  it("prefers the exact period start received from Stripe", () => {
    const exact = new Date("2026-08-05T00:00:00Z");
    const end = new Date("2026-10-01T00:00:00Z");
    expect(
      periodStart({ currentPeriodStart: exact, currentPeriodEnd: end, createdAt }, now),
    ).toEqual(exact);
  });

  it("uses account creation when there is no subscription period", () => {
    expect(periodStart({ currentPeriodEnd: null, createdAt }, now)).toEqual(createdAt);
  });

  it("ignores a stale (past) currentPeriodEnd", () => {
    const stale = new Date("2026-08-01T00:00:00Z");
    expect(periodStart({ currentPeriodEnd: stale, createdAt }, now)).toEqual(createdAt);
  });

  it("clamps the day when the previous month is shorter", () => {
    const march = new Date("2026-03-31T09:30:00Z");
    expect(
      periodStart(
        { currentPeriodEnd: march, createdAt: new Date("2026-01-01T00:00:00Z") },
        new Date("2026-03-15T00:00:00Z"),
      ).toISOString(),
    ).toBe("2026-02-28T09:30:00.000Z");
  });

  it("crosses the year boundary without overflowing", () => {
    const january = new Date("2027-01-31T00:00:00Z");
    expect(
      periodStart(
        { currentPeriodEnd: january, createdAt: new Date("2026-11-01T00:00:00Z") },
        new Date("2027-01-10T00:00:00Z"),
      ).toISOString(),
    ).toBe("2026-12-31T00:00:00.000Z");
  });
});

describe("canStartCheckout", () => {
  it("allows a first checkout and a retry of an incomplete one", () => {
    expect(canStartCheckout({ status: "trialing", stripeSubscriptionId: null })).toBe(true);
    expect(canStartCheckout({ status: "incomplete", stripeSubscriptionId: "sub_1" })).toBe(true);
  });

  it("still refuses a second checkout for a live subscription", () => {
    expect(canStartCheckout({ status: "active", stripeSubscriptionId: "sub_1" })).toBe(false);
    expect(canStartCheckout({ status: "past_due", stripeSubscriptionId: "sub_1" })).toBe(false);
  });
});

describe("displayPlanName", () => {
  it("hides the internal self-host label when Stripe is off", () => {
    expect(displayPlanName({ enabled: false, planName: "Self-host", status: "self_hosted" })).toBe(
      "Sem cobrança",
    );
    expect(displayPlanName({ enabled: true, planName: "Starter", status: "active" })).toBe(
      "Starter",
    );
  });
});

describe("displayPlanStatus", () => {
  it("translates billing statuses", () => {
    expect(displayPlanStatus("trialing")).toBe("em trial");
    expect(displayPlanStatus("past_due")).toBe("pagamento atrasado");
    expect(displayPlanStatus("self_hosted")).toBe("sem cobrança");
  });
});

describe("isPlanLimitError", () => {
  it("prefers the structured code and keeps the legacy message fallback", () => {
    expect(isPlanLimitError({ data: { code: PLAN_LIMIT_CODE }, message: "Erro inesperado" })).toBe(
      true,
    );
    expect(isPlanLimitError({ code: PLAN_LIMIT_CODE, message: "Erro inesperado" })).toBe(true);
    expect(isPlanLimitError("Limite mensal de tokens atingido")).toBe(true);
    expect(isPlanLimitError("Invalid session token")).toBe(false);
  });
});

describe("formatMeter", () => {
  it("shows used over limit, or just used when unlimited", () => {
    expect(formatMeter(2, 3)).toBe("2 / 3");
    expect(formatMeter(7, null)).toBe("7");
    expect(formatMeter(500_000, 3_000_000, formatTokenBudget)).toBe("500k / 3M");
  });
});

describe("mapStripeStatus", () => {
  it("maps the closed set", () => {
    expect(mapStripeStatus("active")).toBe("active");
    expect(mapStripeStatus("trialing")).toBe("trialing");
    expect(mapStripeStatus("canceled")).toBe("canceled");
    expect(mapStripeStatus("incomplete_expired")).toBe("canceled");
    expect(mapStripeStatus("past_due")).toBe("past_due");
    expect(mapStripeStatus("unpaid")).toBe("past_due");
    expect(mapStripeStatus("incomplete")).toBe("incomplete");
    expect(mapStripeStatus("paused")).toBe("past_due");
    expect(mapStripeStatus("something_new")).toBe("past_due");
  });
});
