import { catalogPlans, PLANS } from "@quibt/core";
import { describe, expect, it } from "vitest";
import {
  CLOUD_PLANS,
  formatMeter,
  formatPlanPrice,
  formatTokenBudget,
  planHighlights,
  TRIAL_DAYS,
} from "./plans";

describe("mobile plan catalog", () => {
  it("derives the trial length from core", () => {
    expect(TRIAL_DAYS).toBe(PLANS.trial.trialDays);
  });

  it("matches the SaaS Trial / Starter / Pro ladder", () => {
    expect(CLOUD_PLANS.map((plan) => plan.id)).toEqual(["trial", "starter", "pro"]);
    expect(formatPlanPrice(0)).toBe("Grátis");
    expect(formatPlanPrice(29)).toBe("$29");
    expect(formatMeter(2, 3)).toBe("2 / 3");
    expect(formatMeter(500_000, 3_000_000, formatTokenBudget)).toBe("500k / 3M");
  });

  it("derives every number from @quibt/core instead of retyping it", () => {
    expect(CLOUD_PLANS.map((plan) => [plan.name, plan.priceUsd, ...plan.highlights])).toEqual(
      catalogPlans().map((plan) => [plan.name, plan.priceUsd, ...planHighlights(plan).slice(0, 3)]),
    );
    expect(CLOUD_PLANS.map((plan) => plan.highlights)).toEqual([
      ["1 bot", "500k tokens / mês", "20h de computador / mês"],
      ["3 bots", "3M tokens / mês", "60h de computador / mês"],
      ["10 bots", "15M tokens / mês", "240h de computador / mês"],
    ]);
  });
});
