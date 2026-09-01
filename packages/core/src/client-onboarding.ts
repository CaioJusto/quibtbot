import { bootableKind } from "./computer-catalog.js";
import type { QuibtEdition } from "./edition.js";

export type ClientOnboardingStep = "plan" | "model" | "machine" | "bot";

/**
 * Onde a pessoa resolve qualquer erro de modelo: o botão "Conectar modelo" ao lado do
 * erro e Conta → Modelo. O runtime e o executor terminam as suas mensagens com isto,
 * para que nenhuma delas mande para um lugar que o menu não tem ("Modelos e tokens").
 */
export const MODEL_CONNECT_HINT = "Toque em Conectar modelo, ou vá em Conta → Modelo.";

/**
 * What the chat shows when a turn has no model key and no subscription. It names the
 * two places that really exist: the "Conectar modelo" button next to this error and
 * Conta → Modelo (the menu never had a "Conta" model item to paste a key into).
 */
export const MISSING_MODEL_MESSAGE = `Não tenho um modelo conectado. ${MODEL_CONNECT_HINT}`;

/**
 * O que a tela diz depois de `models.connect`. O servidor só sonda OpenRouter, xAI,
 * Ollama e OpenAI-compatible; para os outros a chave é guardada sem consulta, e dizer
 * "confirmada ✓" ali era promessa falsa: a primeira mensagem ainda podia falhar com 401.
 */
export function connectedModelNotice(input: { verified: boolean; local: boolean }): string {
  if (!input.verified) return "Chave guardada. Vai ser conferida na primeira mensagem.";
  return input.local ? "Servidor confirmado ✓" : "Chave confirmada ✓";
}

/**
 * Dica ao lado do campo de URL do modelo local. `localModelUrl` continua em 127.0.0.1,
 * que é o certo quando a API roda no próprio computador (`pnpm dev`); no app desktop e
 * no compose a API está num container, e 127.0.0.1 ali é o próprio container.
 */
export const LOCAL_MODEL_DOCKER_HINT =
  "Se o Quibt roda em Docker (app desktop ou compose), troque 127.0.0.1 por host.docker.internal.";

/**
 * Erros de chave, crédito ou modelo ausente que um botão "Conectar modelo" resolve.
 * O run.failed chega cru do provedor ("401 Unauthorized", "insufficient credits"); o
 * probe do connect já chega em português. Todos caem no mesmo lugar: Conta → Modelo.
 */
const MODEL_CONNECTION_ERROR =
  /não tenho um modelo|provider is not configured|chave recusada|sem crédito|\b40[12]\b|unauthorized|invalid api key|incorrect api key|authentication|insufficient credits|run out of credits|spending-limit|no auth credentials/i;

export function needsModelConnection(message: string | null | undefined): boolean {
  if (!message) return false;
  return MODEL_CONNECTION_ERROR.test(message);
}

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

export type TokenSource = "plan" | "key" | "subscription" | "local" | "cli";

const LOCAL_PROVIDERS = new Set(["ollama", "openai-compatible"]);
const HOST_CLI_PROVIDER = "local-cli";

export type ProviderEntry = {
  provider: string;
  id: string;
  auth?: "api-key" | "oauth" | "both" | "host-cli";
  subscription?: boolean;
  signIn?: "device-code";
};

/**
 * Providers that can actually pay for a model in the chosen way.
 *
 * A aba Assinatura lista só quem tem o login implementado no app (device code:
 * ChatGPT Plus/Pro, Copilot, SuperGrok). O catálogo do Pi marca outros provedores como
 * assinatura, mas sem fluxo de login o "Continuar" gravava um provedor sem credencial
 * e o bot nascia mudo.
 */
export function providersForMode<T extends ProviderEntry>(providers: T[], mode: TokenSource): T[] {
  if (mode === "subscription") {
    return providers.filter((entry) => entry.signIn === "device-code");
  }
  if (mode === "local") {
    return providers.filter((entry) => LOCAL_PROVIDERS.has(entry.provider));
  }
  if (mode === "cli") {
    return providers.filter((entry) => entry.provider === HOST_CLI_PROVIDER);
  }
  if (mode === "key") {
    return providers.filter(
      (entry) =>
        !LOCAL_PROVIDERS.has(entry.provider) &&
        entry.provider !== HOST_CLI_PROVIDER &&
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
  if (entry.provider === HOST_CLI_PROVIDER) return "cli";
  if (LOCAL_PROVIDERS.has(entry.provider)) return "local";
  if (entry.signIn === "device-code") return "subscription";
  return "key";
}

/**
 * Which card starts selected on the model step. "Minha assinatura" comes first and is
 * the default when the catalog has a sign-in to offer — unless this account already
 * connected the deploy's default provider, which then opens on its own card.
 */
export function initialTokenSource<T extends ProviderEntry>(input: {
  catalog: T[];
  preferred?: T;
  connected: Iterable<string>;
  fallback: TokenSource;
}): TokenSource {
  if (input.fallback === "plan") return "plan";
  const connected = new Set(input.connected);
  if (input.preferred && connected.has(input.preferred.provider)) {
    return modeForProvider(input.preferred);
  }
  return input.catalog.some((entry) => entry.signIn === "device-code") ? "subscription" : "key";
}

/**
 * Qual entrada do catálogo abre selecionada: a credencial padrão da conta, depois
 * qualquer provedor já conectado, depois o OpenRouter. O mobile fixava o OpenRouter e
 * quem tinha só o Copilot conectado caía em "Minha assinatura" apontando para outro
 * provedor, com "Continuar" travado até trocar na mão.
 */
export function preferredCatalogEntry<T extends ProviderEntry>(
  catalog: T[],
  credentials: Iterable<{ provider: string; isDefault?: boolean }>,
): T | undefined {
  const saved = [...credentials];
  const byProvider = (provider: string | undefined) =>
    provider ? catalog.find((entry) => entry.provider === provider) : undefined;
  return (
    byProvider(saved.find((credential) => credential.isDefault)?.provider) ??
    catalog.find((entry) => saved.some((credential) => credential.provider === entry.provider)) ??
    byProvider("openrouter") ??
    catalog[0]
  );
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
  if (!item) return { ok: false, message: "Escolha Docker, a sua VPS, E2B, Box ou Daytona." };
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
  | { kind: "cli" }
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
  if (input.tokenSource === "cli") return { kind: "cli" };
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
