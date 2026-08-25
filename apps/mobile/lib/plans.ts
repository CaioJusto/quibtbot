import {
  catalogPlans,
  formatPlanPrice as coreFormatPlanPrice,
  planHighlights as corePlanHighlights,
  PLANS,
} from "@quibt/core";

export const TRIAL_DAYS = PLANS.trial.trialDays;

/**
 * Derived from `@quibt/core`, never retyped: onboarding shows the same bots,
 * tokens, and hours the API enforces. Used before a billing snapshot exists —
 * once it does, render `billing.plans` instead.
 */
export const CLOUD_PLANS = catalogPlans().map((plan) => ({
  id: plan.id,
  name: plan.name,
  priceUsd: plan.priceUsd,
  highlights: corePlanHighlights(plan).slice(0, 3),
}));

export type CloudPlanId = (typeof CLOUD_PLANS)[number]["id"];

export {
  displayPlanName,
  displayPlanStatus,
  formatMeter,
  formatTokenBudget,
  isPlanLimitError,
} from "@quibt/core";

/** Mobile passes the bare number; the core helper takes the plan. */
export function formatPlanPrice(priceUsd: number) {
  return coreFormatPlanPrice({ priceUsd });
}

/** The three lines a plan card has room for on a phone. */
export function planHighlights(plan: {
  maxBots: number | null;
  tokensPerMonth: number | null;
  computerMinutesPerMonth: number | null;
}): string[] {
  return corePlanHighlights(plan).slice(0, 3);
}
