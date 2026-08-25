import {
  chooseMode,
  chooseProvider,
  chosenMachineMatches,
  initialTokenSource,
  localModelUrl,
  type MachineNotice,
  type ModelChoice,
  type ModelSaveAction,
  machineCredentialsReady,
  machineNotice,
  modelSaveAction,
  type ProviderEntry,
  providersForMode,
  type QuibtEdition,
  type TokenSource,
} from "@quibt/core";
import { resolveClientEdition } from "./edition-client";

export {
  chooseMode,
  chooseProvider,
  chosenMachineMatches,
  initialTokenSource,
  localModelUrl,
  type MachineNotice,
  type ModelChoice,
  type ModelSaveAction,
  machineCredentialsReady,
  machineNotice,
  modelSaveAction,
  type ProviderEntry,
  providersForMode,
  type TokenSource,
};

/** What onboarding needs to know about the deploy. Fields the server may not send stay optional. */
export type EditionFacts = {
  edition?: QuibtEdition;
  canChooseMachine?: boolean;
  availableMachines?: string[];
  /** The provider this process actually boots with, as reported by `health`. */
  sandbox?: string;
};

export type OnboardingFlow = {
  edition: QuibtEdition;
  canChooseMachine: boolean;
  availableMachines: string[];
  runningSandbox: string;
  firstStep: "plan" | "model";
  tokenSource: "plan" | "key";
};

/**
 * The client never decides the edition on its own: it obeys `health`, then the authenticated
 * `me`, and only guesses from the billing snapshot when the server said nothing at all.
 */
export function resolveOnboardingFlow(input: {
  health?: EditionFacts | null;
  me?: {
    edition?: QuibtEdition;
    canChooseMachine?: boolean;
    sandboxProvider?: string | null;
  } | null;
  billing?: { enabled?: boolean } | null;
}): OnboardingFlow {
  const edition = resolveClientEdition(input);
  const canChooseMachine =
    input.health?.canChooseMachine ?? input.me?.canChooseMachine ?? edition === "oss";
  return {
    edition,
    canChooseMachine,
    availableMachines: input.health?.availableMachines?.length
      ? input.health.availableMachines
      : ["docker"],
    runningSandbox: input.health?.sandbox ?? input.me?.sandboxProvider ?? "docker",
    firstStep: edition === "cloud" ? "plan" : "model",
    tokenSource: edition === "cloud" ? "plan" : "key",
  };
}
