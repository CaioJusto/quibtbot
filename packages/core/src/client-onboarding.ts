import { bootableKind } from "./computer-catalog.js";
import type { QuibtEdition } from "./edition.js";

export type ClientOnboardingStep = "plan" | "model" | "machine" | "bot";

/** What the chat shows when a turn has no model key and no subscription. */
export const MISSING_MODEL_MESSAGE =
  "Não tenho um modelo conectado. Cole uma chave em Conta, ou volte no onboarding.";

/**
 * Docker is the default install path — still confirm it once so the owner sees
 * "Nesta máquina (Docker)" instead of jumping Modelo → Bot with no computer story.
 * Box / E2B / a remote supervisor were already chosen; Ajustes → Máquina is enough.
 */
export function machineStepNeeded(input: { sandbox?: string | null }): boolean {
  const sandbox = (input.sandbox ?? "").trim().toLowerCase();
  if (sandbox === "box" || sandbox === "e2b" || sandbox === "remote-supervisor") return false;
  return true;
}

/** Which steps the client shows after edition and owner facts are known. */
export function clientOnboardingSteps(
  edition: QuibtEdition,
  input: { canChooseMachine?: boolean; isOwner?: boolean; sandbox?: string | null } = {},
): [ClientOnboardingStep, ...ClientOnboardingStep[]] {
  const { canChooseMachine = false, isOwner = false } = input;
  const steps: ClientOnboardingStep[] = edition === "cloud" ? ["plan", "model"] : ["model"];
  if (canChooseMachine && isOwner && machineStepNeeded(input)) steps.push("machine");
  steps.push("bot");
  return steps as [ClientOnboardingStep, ...ClientOnboardingStep[]];
}

export function nextStepAfterModel(input: {
  canChooseMachine: boolean;
  isOwner: boolean;
  sandbox?: string | null;
}): "machine" | "bot" {
  return input.canChooseMachine && input.isOwner && machineStepNeeded(input) ? "machine" : "bot";
}

export type TokenSource = "plan" | "key" | "subscription" | "local";

const LOCAL_PROVIDERS = new Set(["ollama", "openai-compatible"]);

export type ProviderEntry = {
  provider: string;
  id: string;
  auth?: "api-key" | "oauth" | "both";
  subscription?: boolean;
  signIn?: "device-code";
};

/** Providers that can actually pay for a model in the chosen way. */
export function providersForMode<T extends ProviderEntry>(providers: T[], mode: TokenSource): T[] {
  if (mode === "subscription") {
    return providers.filter(
      (entry) => entry.subscription || entry.signIn === "device-code" || entry.auth === "oauth",
    );
  }
  if (mode === "local") {
    return providers.filter((entry) => LOCAL_PROVIDERS.has(entry.provider));
  }
  if (mode === "key") {
    return providers.filter(
      (entry) =>
        !LOCAL_PROVIDERS.has(entry.provider) &&
        (entry.auth !== "oauth" || entry.provider === "openrouter"),
    );
  }
  return providers;
}

/**
 * Em que aba do seletor uma credencial já salva aparece. A tela de Conta abria sempre
 * em "Chave OpenRouter": quem tinha assinatura conectada lia que estava no OpenRouter,
 * com um modelo que nunca escolheu. Espelha `providersForMode`.
 */
export function modeForProvider(entry: ProviderEntry): TokenSource {
  if (LOCAL_PROVIDERS.has(entry.provider)) return "local";
  if (entry.subscription || entry.signIn === "device-code") return "subscription";
  if (entry.auth === "oauth" && entry.provider !== "openrouter") return "subscription";
  return "key";
}

export function localModelUrl(provider: string): string {
  return provider === "openai-compatible" ? "http://127.0.0.1:1234/v1" : "http://127.0.0.1:11434";
}

/** Recipe kinds (vps-hetzner) activate as another family (remote-supervisor). */
export function chosenMachineMatches(saved: string | null, chosen: string): boolean {
  if (!saved) return false;
  return saved === chosen || saved === bootableKind(chosen);
}

export function machineCredentialsReady(
  item:
    | {
        needsKey: boolean;
        needsEndpoint: boolean;
        configured?: boolean;
        keyLabel?: string;
        endpointLabel?: string;
      }
    | undefined,
  input: { endpoint: string; apiKey: string },
): { ok: true } | { ok: false; message: string } {
  if (!item) return { ok: false, message: "Escolha Docker, a sua VPS, E2B ou Box." };
  if (item.needsEndpoint && !input.endpoint.trim() && !item.configured) {
    return { ok: false, message: item.endpointLabel ?? "Cole a URL do supervisor da sua VPS." };
  }
  if (item.needsKey && !input.apiKey.trim() && !item.configured) {
    return { ok: false, message: item.keyLabel ?? "Cole a chave da sua conta para esta máquina." };
  }
  return { ok: true };
}

export type ModelChoice = { provider: string; modelId: string; apiKey: string };

const PREFERRED_MODELS: Record<string, string[]> = {
  "openai-codex": ["gpt-5.6-terra", "gpt-5.5", "gpt-5.4"],
};

export function chooseProvider<T extends ProviderEntry>(
  choice: ModelChoice,
  catalog: T[],
  provider: string,
): ModelChoice {
  if (provider === choice.provider) return choice;
  const forProvider = catalog.filter((entry) => entry.provider === provider);
  const preferred = (PREFERRED_MODELS[provider] ?? [])
    .map((id) => forProvider.find((entry) => entry.id === id))
    .find(Boolean);
  const first = preferred ?? forProvider[0];
  return { provider, modelId: first?.id ?? choice.modelId, apiKey: "" };
}

/** Switching how you pay must not leave a provider selected that the new mode cannot use. */
export function chooseMode<T extends ProviderEntry>(
  choice: ModelChoice,
  catalog: T[],
  mode: TokenSource,
): ModelChoice {
  if (mode === "plan") return choice;
  const allowed = providersForMode(catalog, mode);
  if (allowed.some((entry) => entry.provider === choice.provider)) return choice;
  const first = allowed[0];
  if (!first) return choice;
  return chooseProvider(choice, catalog, first.provider);
}

export type ModelSaveAction =
  | { kind: "plan" }
  | { kind: "connect" }
  | { kind: "default" }
  | { kind: "blocked"; message: string };

/**
 * What "Continuar" on the model step really does. Advancing without saving anything is a lie,
 * so a mode that needs a key or a sign-in says so instead.
 */
export function modelSaveAction(input: {
  tokenSource: TokenSource;
  apiKey: string;
  acceptsKey: boolean;
  needsSignIn: boolean;
  signedIn: boolean;
}): ModelSaveAction {
  if (input.tokenSource === "plan") return { kind: "plan" };
  const key = input.apiKey.trim();
  if (key && input.acceptsKey) return { kind: "connect" };
  if (input.tokenSource === "key" || input.tokenSource === "local") {
    if (!input.acceptsKey) return { kind: "default" };
    return {
      kind: "blocked",
      message:
        input.tokenSource === "local"
          ? "Cole a URL do modelo local (ex. http://127.0.0.1:11434) para continuar, ou toque em “Pular por agora”."
          : "Cole a chave de API para continuar, ou toque em “Pular por agora”.",
    };
  }
  if (input.needsSignIn && !input.signedIn) {
    return {
      kind: "blocked",
      message: "Entre com a sua assinatura para continuar, ou toque em “Pular por agora”.",
    };
  }
  return { kind: "default" };
}

export type MachineNotice = { tone: "ok" | "warn" | "info"; text: string };

export function machineNotice(input: {
  chosen: string;
  running: string;
  saved: string | null;
}): MachineNotice | null {
  const live =
    input.running === input.chosen || input.running === (bootableKind(input.chosen) ?? "");
  if (chosenMachineMatches(input.saved, input.chosen)) {
    return live
      ? { tone: "ok", text: `Salvo. Este deploy roda o computador em ${input.chosen}.` }
      : {
          tone: "warn",
          text: `Salvo, mas este processo ainda roda em ${input.running}. Coloque SANDBOX_PROVIDER=${input.chosen} no .env e reinicie API e worker para a escolha valer.`,
        };
  }
  if (live) return null;
  return {
    tone: "info",
    text: `Este processo está rodando em ${input.running}. Nada muda até você salvar.`,
  };
}

export type MachineProbeResult = { ok: boolean; message: string };

/** Probe must succeed before activate; credentials must be ready first. */
export function machineActivationGate(input: {
  credentialsReady: boolean;
  credentialsMessage?: string;
  probe: MachineProbeResult | null;
}): { ok: true; action: "activate" } | { ok: false; action: "probe" | "blocked"; message: string } {
  if (!input.credentialsReady) {
    return {
      ok: false,
      action: "blocked",
      message: input.credentialsMessage ?? "Preencha os campos da máquina.",
    };
  }
  if (!input.probe) {
    return { ok: false, action: "probe", message: "Teste a máquina antes de salvar." };
  }
  if (!input.probe.ok) {
    return { ok: false, action: "blocked", message: input.probe.message };
  }
  return { ok: true, action: "activate" };
}

/** Picker cards hide recipes, but recipes stay in the catalog for VPS hints. */
export function splitMachineCatalog<T extends { recipe?: unknown }>(items: T[]) {
  return {
    cards: items.filter((item) => !item.recipe),
    recipes: items.filter((item) => item.recipe),
  };
}
