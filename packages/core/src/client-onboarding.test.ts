import { describe, expect, it } from "vitest";
import {
  chooseMode,
  chooseProvider,
  chosenMachineMatches,
  clientOnboardingSteps,
  connectedModelNotice,
  initialTokenSource,
  LOCAL_MODEL_DOCKER_HINT,
  localModelUrl,
  MISSING_MODEL_MESSAGE,
  MODEL_CONNECT_HINT,
  machineActivationGate,
  machineCredentialsReady,
  machineNotice,
  machineStepNeeded,
  modeForProvider,
  modelSaveAction,
  needsModelConnection,
  nextStepAfterModel,
  preferredCatalogEntry,
  providersForMode,
  splitMachineCatalog,
} from "./client-onboarding.js";

const catalog = [
  { provider: "openrouter", id: "or/one", auth: "api-key" as const },
  { provider: "anthropic", id: "an/one", auth: "both" as const, subscription: true },
  { provider: "ollama", id: "llama3.2", auth: "api-key" as const },
  { provider: "openai-compatible", id: "local-model", auth: "api-key" as const },
  { provider: "local-cli", id: "codex", auth: "host-cli" as const, subscription: true },
  { provider: "copilot", id: "gh/one", auth: "oauth" as const, signIn: "device-code" as const },
  // Assinatura no catálogo do Pi, mas sem login implementado no app.
  { provider: "kimi-for-coding", id: "kimi/one", auth: "oauth" as const, subscription: true },
];

describe("clientOnboardingSteps", () => {
  it("OSS owner resolves to model, machine and bot", () => {
    expect(clientOnboardingSteps("oss", { canChooseMachine: true, isOwner: true })).toEqual([
      "model",
      "machine",
      "bot",
    ]);
  });

  it("OSS non-owner skips machine", () => {
    expect(clientOnboardingSteps("oss", { canChooseMachine: true, isOwner: false })).toEqual([
      "model",
      "bot",
    ]);
  });

  it("keeps plan then model on Cloud", () => {
    expect(clientOnboardingSteps("cloud", { canChooseMachine: false, isOwner: false })).toEqual([
      "plan",
      "model",
      "bot",
    ]);
  });
});

describe("nextStepAfterModel", () => {
  it("sends owners who can choose a machine to the machine step", () => {
    expect(nextStepAfterModel({ canChooseMachine: true, isOwner: true })).toBe("machine");
  });

  it("skips machine for non-owners", () => {
    expect(nextStepAfterModel({ canChooseMachine: true, isOwner: false })).toBe("bot");
  });
});

describe("providersForMode", () => {
  it("keeps key providers out of the subscription list and vice versa", () => {
    expect(providersForMode(catalog, "key").map((entry) => entry.provider)).toEqual([
      "openrouter",
      "anthropic",
    ]);
    expect(providersForMode(catalog, "local").map((entry) => entry.provider)).toEqual([
      "ollama",
      "openai-compatible",
    ]);
    expect(providersForMode(catalog, "subscription").map((entry) => entry.provider)).toEqual([
      "copilot",
    ]);
    expect(providersForMode(catalog, "cli").map((entry) => entry.provider)).toEqual(["local-cli"]);
    expect(providersForMode(catalog, "plan")).toHaveLength(7);
  });

  it("só oferece na aba Assinatura quem tem o login pelo código implementado", () => {
    // O Pi marca a Anthropic e o Kimi como assinatura, mas o app só sabe entrar com
    // device code. Listar os outros gravava um provedor sem credencial: bot mudo.
    const subscription = providersForMode(catalog, "subscription").map((entry) => entry.provider);
    expect(subscription).not.toContain("anthropic");
    expect(subscription).not.toContain("kimi-for-coding");
    // Quem aceita chave continua na aba da chave; quem só tem OAuth sem login, em nenhuma.
    expect(providersForMode(catalog, "key").map((entry) => entry.provider)).toContain("anthropic");
    expect(providersForMode(catalog, "key").map((entry) => entry.provider)).not.toContain(
      "kimi-for-coding",
    );
  });
});

describe("initialTokenSource", () => {
  it("abre em Minha assinatura quando há login para oferecer", () => {
    expect(
      initialTokenSource({ catalog, preferred: catalog[0], connected: [], fallback: "key" }),
    ).toBe("subscription");
  });

  it("cai na chave quando o catálogo não tem assinatura com login", () => {
    const keysOnly = catalog.filter((entry) => entry.signIn !== "device-code");
    expect(initialTokenSource({ catalog: keysOnly, connected: [], fallback: "key" })).toBe("key");
  });

  it("abre no cartão da credencial que a conta já conectou", () => {
    expect(
      initialTokenSource({
        catalog,
        preferred: catalog[0],
        connected: ["openrouter"],
        fallback: "key",
      }),
    ).toBe("key");
    expect(
      initialTokenSource({
        catalog,
        preferred: catalog[2],
        connected: ["ollama"],
        fallback: "key",
      }),
    ).toBe("local");
  });

  it("mantém os tokens do plano na Cloud", () => {
    expect(initialTokenSource({ catalog, connected: [], fallback: "plan" })).toBe("plan");
  });
});

describe("needsModelConnection", () => {
  it("reconhece o modelo ausente e os erros de chave ou crédito", () => {
    expect(needsModelConnection(MISSING_MODEL_MESSAGE)).toBe(true);
    expect(needsModelConnection("401 Unauthorized")).toBe(true);
    expect(needsModelConnection("OpenAI API error (402): insufficient credits")).toBe(true);
    expect(needsModelConnection("Chave recusada pelo OpenRouter.")).toBe(true);
    expect(needsModelConnection("Provider is not configured: openrouter")).toBe(true);
  });

  it("deixa em paz os erros que um modelo novo não resolve", () => {
    expect(needsModelConnection("O computador não ligou: o Docker recusou o processo.")).toBe(
      false,
    );
    expect(needsModelConnection("Só quem instalou o Quibt pode mudar esta configuração.")).toBe(
      false,
    );
    expect(needsModelConnection(null)).toBe(false);
  });

  it("aponta para lugares que existem: o botão e Conta → Modelo", () => {
    expect(MISSING_MODEL_MESSAGE).toContain("Conectar modelo");
    expect(MISSING_MODEL_MESSAGE).toContain("Conta → Modelo");
    // O runtime termina as mensagens irmãs com o mesmo sufixo, para nunca divergir.
    expect(MISSING_MODEL_MESSAGE.endsWith(MODEL_CONNECT_HINT)).toBe(true);
    expect(MODEL_CONNECT_HINT).toBe("Toque em Conectar modelo, ou vá em Conta → Modelo.");
    expect(MODEL_CONNECT_HINT).not.toContain("Modelos e tokens");
  });
});

describe("connectedModelNotice", () => {
  it("só afirma 'confirmada' quando o servidor sondou o provedor", () => {
    expect(connectedModelNotice({ verified: true, local: false })).toBe("Chave confirmada ✓");
    expect(connectedModelNotice({ verified: true, local: true })).toBe("Servidor confirmado ✓");
  });

  it("diz que a chave só foi guardada quando ninguém a conferiu", () => {
    for (const local of [false, true]) {
      const notice = connectedModelNotice({ verified: false, local });
      expect(notice).toBe("Chave guardada. Vai ser conferida na primeira mensagem.");
      expect(notice).not.toContain("✓");
    }
  });
});

describe("preferredCatalogEntry", () => {
  it("abre na credencial padrão da conta, mesmo que não seja o OpenRouter", () => {
    const entry = preferredCatalogEntry(catalog, [
      { provider: "openrouter", isDefault: false },
      { provider: "copilot", isDefault: true },
    ]);
    expect(entry?.provider).toBe("copilot");
  });

  it("cai em qualquer provedor conectado quando nenhum é o padrão", () => {
    expect(preferredCatalogEntry(catalog, [{ provider: "copilot" }])?.provider).toBe("copilot");
    // A ordem do catálogo decide entre dois conectados sem padrão.
    expect(
      preferredCatalogEntry(catalog, [{ provider: "ollama" }, { provider: "anthropic" }])?.provider,
    ).toBe("anthropic");
  });

  it("sem credencial fica no OpenRouter, e sem OpenRouter no primeiro do catálogo", () => {
    expect(preferredCatalogEntry(catalog, [])?.provider).toBe("openrouter");
    expect(preferredCatalogEntry(catalog.slice(1), [])?.provider).toBe("anthropic");
    expect(preferredCatalogEntry([], [{ provider: "copilot" }])).toBeUndefined();
  });

  it("ignora uma credencial de provedor que o catálogo não tem", () => {
    expect(preferredCatalogEntry(catalog, [{ provider: "gone", isDefault: true }])?.provider).toBe(
      "openrouter",
    );
  });

  it("marca a aba certa junto com initialTokenSource", () => {
    const connected = [{ provider: "copilot", isDefault: true }];
    const preferred = preferredCatalogEntry(catalog, connected);
    expect(
      initialTokenSource({
        catalog,
        preferred,
        connected: connected.map((entry) => entry.provider),
        fallback: "key",
      }),
    ).toBe("subscription");
  });
});

describe("local model helpers", () => {
  it("defaults Ollama to the local daemon URL", () => {
    expect(localModelUrl("ollama")).toBe("http://127.0.0.1:11434");
    expect(localModelUrl("openai-compatible")).toBe("http://127.0.0.1:1234/v1");
  });

  it("explica o host.docker.internal sem trocar o padrão de quem roda a API no próprio PC", () => {
    expect(LOCAL_MODEL_DOCKER_HINT).toContain("host.docker.internal");
    expect(LOCAL_MODEL_DOCKER_HINT).toContain("Docker");
    expect(localModelUrl("ollama")).not.toContain("host.docker.internal");
  });

  it("treats a VPS recipe as the remote supervisor once saved", () => {
    expect(chosenMachineMatches("remote-supervisor", "vps-hetzner")).toBe(true);
    expect(chosenMachineMatches("docker", "vps-hetzner")).toBe(false);
    expect(chosenMachineMatches("e2b", "e2b")).toBe(true);
  });
});

describe("machineCredentialsReady", () => {
  it("lets Docker continue without a key", () => {
    expect(
      machineCredentialsReady(
        { needsKey: false, needsEndpoint: false },
        { endpoint: "", apiKey: "" },
      ).ok,
    ).toBe(true);
  });

  it("asks for a cloud sandbox key unless that machine is already configured", () => {
    expect(
      machineCredentialsReady(
        { needsKey: true, needsEndpoint: false },
        { endpoint: "", apiKey: "" },
      ).ok,
    ).toBe(false);
    expect(
      machineCredentialsReady(
        { needsKey: true, needsEndpoint: false, configured: true },
        { endpoint: "", apiKey: "" },
      ).ok,
    ).toBe(true);
  });
});

describe("chooseProvider", () => {
  it("drops the key typed for the previous provider", () => {
    const next = chooseProvider(
      { provider: "openrouter", modelId: "or/one", apiKey: "sk-openrouter" },
      catalog,
      "anthropic",
    );
    expect(next).toEqual({ provider: "anthropic", modelId: "an/one", apiKey: "" });
  });
});

describe("chooseMode", () => {
  it("moves off a provider the new mode cannot use", () => {
    const next = chooseMode({ provider: "copilot", modelId: "gh/one", apiKey: "" }, catalog, "key");
    expect(next.provider).toBe("openrouter");
  });
});

describe("modelSaveAction", () => {
  const base = { acceptsKey: true, needsSignIn: false, signedIn: false };

  it("refuses to pretend it saved a key that was never typed", () => {
    expect(modelSaveAction({ ...base, tokenSource: "key", apiKey: "   " })).toEqual({
      kind: "blocked",
      message: "Cole a chave de API para continuar, ou toque em “Pular por agora”.",
    });
  });

  it("connects the key when there is one", () => {
    expect(modelSaveAction({ ...base, tokenSource: "key", apiKey: "sk-1" }).kind).toBe("connect");
  });

  it("ativates a detected host CLI without asking for a key", () => {
    expect(modelSaveAction({ ...base, tokenSource: "cli", apiKey: "" })).toEqual({
      kind: "cli",
    });
  });
});

describe("machineNotice", () => {
  it("never says a choice took effect while the process runs elsewhere", () => {
    const notice = machineNotice({ chosen: "e2b", running: "docker", saved: "e2b" });
    expect(notice?.tone).toBe("warn");
  });
});

describe("machineActivationGate", () => {
  it("requires a successful probe before activate", () => {
    expect(
      machineActivationGate({
        credentialsReady: true,
        probe: null,
      }),
    ).toEqual({ ok: false, action: "probe", message: "Teste a máquina antes de salvar." });
    expect(
      machineActivationGate({
        credentialsReady: true,
        probe: { ok: false, message: "Docker não respondeu." },
      }),
    ).toEqual({ ok: false, action: "blocked", message: "Docker não respondeu." });
    expect(
      machineActivationGate({
        credentialsReady: true,
        probe: { ok: true, message: "Docker respondeu." },
      }),
    ).toEqual({ ok: true, action: "activate" });
  });
});

describe("splitMachineCatalog", () => {
  it("keeps recipes in the catalog while hiding them from picker cards", () => {
    const items = [
      { kind: "docker", recipe: undefined },
      { kind: "vps-hetzner", recipe: { hint: "Hetzner" } },
    ];
    const split = splitMachineCatalog(items);
    expect(split.cards.map((item) => item.kind)).toEqual(["docker"]);
    expect(split.recipes.map((item) => item.kind)).toEqual(["vps-hetzner"]);
    expect(items).toHaveLength(2);
  });
});

describe("machine step", () => {
  it("still asks on Docker so the owner confirms this computer", () => {
    expect(machineStepNeeded({ sandbox: "docker" })).toBe(true);
    expect(machineStepNeeded({ sandbox: "DOCKER" })).toBe(true);
    expect(machineStepNeeded({ sandbox: "box" })).toBe(false);
    expect(machineStepNeeded({ sandbox: "e2b" })).toBe(false);
    expect(machineStepNeeded({ sandbox: "remote-supervisor" })).toBe(false);
  });

  it("stays when there is a real choice to make", () => {
    expect(machineStepNeeded({ sandbox: null })).toBe(true);
    expect(machineStepNeeded({ sandbox: "" })).toBe(true);
    expect(machineStepNeeded({ sandbox: "fake" })).toBe(true);
  });

  it("shows Docker neste aparelho on a fresh install instead of skipping to the bot", () => {
    expect(
      clientOnboardingSteps("oss", { canChooseMachine: true, isOwner: true, sandbox: "docker" }),
    ).toEqual(["model", "machine", "bot"]);
    expect(nextStepAfterModel({ canChooseMachine: true, isOwner: true, sandbox: "docker" })).toBe(
      "machine",
    );
  });

  it("still asks when the server did not say what it has", () => {
    expect(clientOnboardingSteps("oss", { canChooseMachine: true, isOwner: true })).toEqual([
      "model",
      "machine",
      "bot",
    ]);
  });
});

describe("modeForProvider", () => {
  it("abre a assinatura conectada na aba da assinatura", () => {
    expect(modeForProvider({ provider: "xai", id: "grok", signIn: "device-code" })).toBe(
      "subscription",
    );
    expect(
      modeForProvider({
        provider: "github-copilot",
        id: "gh/one",
        auth: "oauth",
        signIn: "device-code",
      }),
    ).toBe("subscription");
  });

  it("mantém OpenRouter como chave, mesmo sendo oauth no catálogo", () => {
    expect(modeForProvider({ provider: "openrouter", id: "or/one", auth: "oauth" })).toBe("key");
    expect(modeForProvider({ provider: "anthropic", id: "an/one", auth: "api-key" })).toBe("key");
  });

  it("uma credencial Anthropic só pode ter vindo de chave colada: abre na aba da chave", () => {
    // Antes, `subscription: true` no catálogo mandava a Conta para a aba Assinatura,
    // que só tem os botões de login — e a Anthropic não tem login no app.
    expect(
      modeForProvider({ provider: "anthropic", id: "an/one", auth: "both", subscription: true }),
    ).toBe("key");
  });

  it("reconhece o modelo local", () => {
    expect(modeForProvider({ provider: "ollama", id: "llama" })).toBe("local");
    expect(modeForProvider({ provider: "local-cli", id: "codex", auth: "host-cli" })).toBe("cli");
  });

  it("concorda com providersForMode", () => {
    const entries = [
      { provider: "openrouter", id: "or/one", auth: "oauth" as const },
      { provider: "xai", id: "grok", signIn: "device-code" as const },
      { provider: "ollama", id: "llama" },
      { provider: "local-cli", id: "claude", auth: "host-cli" as const },
    ];
    for (const entry of entries) {
      expect(providersForMode(entries, modeForProvider(entry))).toContainEqual(entry);
    }
  });
});
