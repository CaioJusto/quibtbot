/**
 * Which onboarding the deploy is running. The edition is the server's call — the app only obeys
 * `health`, falling back to the billing snapshot when the server did not answer.
 */

import { type ClientOnboardingStep, clientOnboardingSteps, nextStepAfterModel } from "@quibt/core";

export type Edition = "oss" | "cloud";
export type OnboardingStep = ClientOnboardingStep;

export function resolveEdition(input: {
  health?: { edition?: string | null } | null;
  billing?: { enabled?: boolean } | null;
}): Edition {
  const raw = input.health?.edition;
  if (raw === "cloud" || raw === "oss") return raw;
  return input.billing?.enabled ? "cloud" : "oss";
}

/** Open Source sells nothing, so it has no plan step — and no step to go back to. */
export function onboardingSteps(
  edition: Edition,
  input: { canChooseMachine?: boolean; isOwner?: boolean; sandbox?: string | null } = {},
): [OnboardingStep, ...OnboardingStep[]] {
  return clientOnboardingSteps(edition, input);
}

export { nextStepAfterModel };

/** Whether finishing onboarding will really open Stripe. Billing off means it never does. */
export function willCheckout(planId: string, billing: { enabled?: boolean } | null): boolean {
  return planId !== "trial" && Boolean(billing?.enabled);
}
