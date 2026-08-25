import { describe, expect, it } from "vitest";
import {
  chooseMode,
  chooseProvider,
  chosenMachineMatches,
  clientOnboardingSteps,
  localModelUrl,
  machineActivationGate,
  machineCredentialsReady,
  machineNotice,
  machineStepNeeded,
  modeForProvider,
  modelSaveAction,
  nextStepAfterModel,
  providersForMode,
  splitMachineCatalog,
} from "./client-onboarding.js";

const catalog = [
  { provider: "openrouter", id: "or/one", auth: "api-key" as const },
  { provider: "anthropic", id: "an/one", auth: "api-key" as const },
  { provider: "ollama", id: "llama3.2", auth: "api-key" as const },
  { provider: "openai-compatible", id: "local-model", auth: "api-key" as const },
  { provider: "copilot", id: "gh/one", auth: "oauth" as const, signIn: "device-code" as const },
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
    expect(providersForMode(catalog, "plan")).toHaveLength(5);
  });
});

describe("local model helpers", () => {
  it("defaults Ollama to the local daemon URL", () => {
    expect(localModelUrl("ollama")).toBe("http://127.0.0.1:11434");
    expect(localModelUrl("openai-compatible")).toBe("http://127.0.0.1:1234/v1");
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

  it("asks for the E2B or Box key unless that machine is already configured", () => {
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
    expect(modeForProvider({ provider: "copilot", id: "gh/one", auth: "oauth" })).toBe(
      "subscription",
    );
  });

  it("mantém OpenRouter como chave, mesmo sendo oauth no catálogo", () => {
    expect(modeForProvider({ provider: "openrouter", id: "or/one", auth: "oauth" })).toBe("key");
    expect(modeForProvider({ provider: "anthropic", id: "an/one", auth: "api-key" })).toBe("key");
  });

  it("reconhece o modelo local", () => {
    expect(modeForProvider({ provider: "ollama", id: "llama" })).toBe("local");
  });

  it("concorda com providersForMode", () => {
    const entries = [
      { provider: "openrouter", id: "or/one", auth: "oauth" as const },
      { provider: "xai", id: "grok", signIn: "device-code" as const },
      { provider: "ollama", id: "llama" },
    ];
    for (const entry of entries) {
      expect(providersForMode(entries, modeForProvider(entry))).toContainEqual(entry);
    }
  });
});
