import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { DEVICE_CODE_PROVIDERS, DEVICE_CODE_SIGN_IN, isDeviceCodeProvider } from "./pi-oauth.js";

export type PiCatalogAuth = "api-key" | "oauth" | "both";
export type PiCatalogSignIn = typeof DEVICE_CODE_SIGN_IN;

export type PiCatalogEntry = {
  provider: string;
  providerName: string;
  id: string;
  label: string;
  billing: string;
  auth: PiCatalogAuth;
  oauthLabel?: string;
  subscription: boolean;
  signIn?: PiCatalogSignIn;
};

export function listPiCatalog(): PiCatalogEntry[] {
  cachedCatalog ??= [...buildPiCatalog(), ...localModelCatalog()];
  return cachedCatalog;
}

/**
 * O modelo padrão de um provedor, quando a credencial chega sem um escolhido.
 *
 * Cair no DEFAULT_MODEL global do .env gravava um modelo de outro provedor — a
 * assinatura do SuperGrok nasceu apontando para um deepseek do OpenRouter, e o
 * primeiro run ia pedir à xAI um modelo que ela não tem.
 */
export function defaultModelForProvider(provider: string): string | undefined {
  const entries = listPiCatalog().filter((entry) => entry.provider === provider);
  if (!entries.length) return undefined;
  // O catálogo lista do mais novo para o mais velho por provedor; o primeiro serve.
  return entries[0]?.id;
}

export function localModelCatalog(): PiCatalogEntry[] {
  return [
    {
      provider: "ollama",
      providerName: "Ollama",
      id: "llama3.2",
      label: "Ollama (local)",
      billing: "Roda em http://127.0.0.1:11434. Quibt Bot não paga o modelo.",
      auth: "api-key",
      subscription: false,
    },
    {
      provider: "openai-compatible",
      providerName: "OpenAI-compatible",
      id: "local-model",
      label: "LM Studio / vLLM / local",
      billing: "Cole a URL base (ex. http://127.0.0.1:1234/v1). Quibt Bot não paga o modelo.",
      auth: "api-key",
      subscription: false,
    },
  ];
}

let cachedCatalog: PiCatalogEntry[] | undefined;

function buildPiCatalog(): PiCatalogEntry[] {
  const models = builtinModels();
  const entries: PiCatalogEntry[] = [];
  for (const provider of models.getProviders()) {
    const apiKey = Boolean(provider.auth.apiKey);
    const oauth = Boolean(provider.auth.oauth);
    const auth: PiCatalogAuth = apiKey && oauth ? "both" : oauth ? "oauth" : "api-key";
    const device = DEVICE_CODE_PROVIDERS[provider.id];
    const oauthLabel =
      device?.loginLabel ?? provider.auth.oauth?.loginLabel ?? provider.auth.oauth?.name;
    const subscription = Boolean(provider.auth.oauth?.isSubscription);
    const signIn = isDeviceCodeProvider(provider.id) ? DEVICE_CODE_SIGN_IN : undefined;
    const billing = catalogBilling(provider.id, provider.name, {
      apiKey,
      oauth,
      oauthLabel,
      subscription,
    });
    for (const model of provider.getModels()) {
      entries.push({
        provider: provider.id,
        providerName: provider.name,
        id: model.id,
        label: model.name || model.id,
        billing,
        auth,
        oauthLabel,
        subscription,
        signIn,
      });
    }
  }
  return entries;
}

function catalogBilling(
  providerId: string,
  name: string,
  opts: { apiKey: boolean; oauth: boolean; oauthLabel?: string; subscription: boolean },
) {
  const device = DEVICE_CODE_PROVIDERS[providerId];
  if (device) return device.billing;
  if (opts.subscription) {
    return `Uses a ${name} subscription when you sign in. Quibt Bot does not pay.`;
  }
  if (opts.oauth && !opts.apiKey) {
    return `Sign in with ${opts.oauthLabel ?? name}. Quibt Bot does not pay.`;
  }
  if (opts.oauth && opts.apiKey) {
    return `API key or ${opts.oauthLabel ?? `${name} sign-in`}. Quibt Bot does not pay.`;
  }
  return `Uses your ${name} key. Quibt Bot does not pay for model usage.`;
}

export const scriptedCatalogEntry: PiCatalogEntry = {
  provider: "scripted",
  providerName: "Scripted",
  id: "scripted",
  label: "Scripted runtime (local verification)",
  billing: "No model charges. Deterministic fixture for tests.",
  auth: "api-key",
  subscription: false,
};
