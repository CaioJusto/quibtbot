import { describe, expect, it } from "vitest";
import {
  chooseMode,
  chooseProvider,
  chosenMachineMatches,
  localModelUrl,
  machineCredentialsReady,
  machineNotice,
  modelSaveAction,
  providersForMode,
  resolveOnboardingFlow,
} from "./onboarding-flow.js";

const catalog = [
  { provider: "openrouter", id: "or/one", auth: "api-key" as const },
  { provider: "anthropic", id: "an/one", auth: "api-key" as const },
  { provider: "ollama", id: "llama3.2", auth: "api-key" as const },
  { provider: "openai-compatible", id: "local-model", auth: "api-key" as const },
  { provider: "copilot", id: "gh/one", auth: "oauth" as const, signIn: "device-code" as const },
];

describe("resolveOnboardingFlow", () => {
  it("skips the plan step and offers the machine step on Open Source", () => {
    const flow = resolveOnboardingFlow({
      health: {
        edition: "oss",
        canChooseMachine: true,
        availableMachines: ["docker", "e2b"],
        sandbox: "docker",
      },
    });
    expect(flow.firstStep).toBe("model");
    expect(flow.tokenSource).toBe("key");
    expect(flow.canChooseMachine).toBe(true);
    expect(flow.availableMachines).toEqual(["docker", "e2b"]);
  });

  it("starts on the plan step and on Quibt tokens in Cloud", () => {
    const flow = resolveOnboardingFlow({
      health: { edition: "cloud", canChooseMachine: false, sandbox: "e2b" },
    });
    expect(flow.firstStep).toBe("plan");
    expect(flow.tokenSource).toBe("plan");
    expect(flow.canChooseMachine).toBe(false);
    expect(flow.runningSandbox).toBe("e2b");
  });

  it("obeys the authenticated me when health did not answer", () => {
    // health is unauthenticated and can fail on its own; me is the next best source of truth.
    const flow = resolveOnboardingFlow({
      health: null,
      me: { edition: "cloud", canChooseMachine: false, sandboxProvider: "e2b" },
      billing: { enabled: false },
    });
    expect(flow.edition).toBe("cloud");
    expect(flow.firstStep).toBe("plan");
    expect(flow.canChooseMachine).toBe(false);
    expect(flow.runningSandbox).toBe("e2b");
  });

  it("falls back to the billing snapshot only when the server said nothing", () => {
    expect(resolveOnboardingFlow({ billing: { enabled: true } }).edition).toBe("cloud");
    expect(resolveOnboardingFlow({}).edition).toBe("oss");
    expect(resolveOnboardingFlow({}).availableMachines).toEqual(["docker"]);
  });

  it("obeys canChooseMachine even when it disagrees with the edition", () => {
    // Server gating is the server's job: the client never re-derives the rule.
    expect(
      resolveOnboardingFlow({ health: { edition: "oss", canChooseMachine: false } })
        .canChooseMachine,
    ).toBe(false);
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
    expect(
      machineCredentialsReady(
        { needsKey: true, needsEndpoint: false },
        { endpoint: "", apiKey: "e2b_xxx" },
      ).ok,
    ).toBe(true);
  });

  it("asks for the VPS URL and token", () => {
    const vps = { needsKey: true, needsEndpoint: true };
    expect(machineCredentialsReady(vps, { endpoint: "", apiKey: "tok" }).ok).toBe(false);
    expect(machineCredentialsReady(vps, { endpoint: "https://vps:7091", apiKey: "" }).ok).toBe(
      false,
    );
    expect(machineCredentialsReady(vps, { endpoint: "https://vps:7091", apiKey: "tok" }).ok).toBe(
      true,
    );
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

  it("keeps the draft when the provider did not change", () => {
    const choice = { provider: "openrouter", modelId: "or/one", apiKey: "sk-1" };
    expect(chooseProvider(choice, catalog, "openrouter")).toBe(choice);
  });

  it("sugere no Codex um modelo que a assinatura libera, não o primeiro da lista", () => {
    const codex = [
      { provider: "openai-codex", id: "gpt-5.3-codex-spark", auth: "oauth" as const },
      { provider: "openai-codex", id: "gpt-5.6-sol", auth: "oauth" as const },
      { provider: "openai-codex", id: "gpt-5.6-terra", auth: "oauth" as const },
    ];
    const next = chooseProvider(
      { provider: "openrouter", modelId: "or/one", apiKey: "" },
      codex,
      "openai-codex",
    );
    expect(next.modelId).toBe("gpt-5.6-terra");
  });

  it("cai no primeiro do catálogo quando nenhum preferido existe", () => {
    const codex = [{ provider: "openai-codex", id: "gpt-9-novo", auth: "oauth" as const }];
    const next = chooseProvider(
      { provider: "openrouter", modelId: "or/one", apiKey: "" },
      codex,
      "openai-codex",
    );
    expect(next.modelId).toBe("gpt-9-novo");
  });
});

describe("chooseMode", () => {
  it("moves off a provider the new mode cannot use", () => {
    const next = chooseMode({ provider: "copilot", modelId: "gh/one", apiKey: "" }, catalog, "key");
    expect(next.provider).toBe("openrouter");
    expect(next.modelId).toBe("or/one");
  });

  it("keeps a provider the new mode can use", () => {
    const choice = { provider: "copilot", modelId: "gh/one", apiKey: "" };
    expect(chooseMode(choice, catalog, "subscription")).toBe(choice);
  });

  it("keeps the selection when the catalog is empty", () => {
    const choice = { provider: "openrouter", modelId: "or/one", apiKey: "sk-1" };
    expect(chooseMode(choice, [], "subscription")).toBe(choice);
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

  it("saves the key typed on a subscription provider instead of dropping it", () => {
    expect(
      modelSaveAction({
        tokenSource: "subscription",
        apiKey: "sk-1",
        acceptsKey: true,
        needsSignIn: true,
        signedIn: false,
      }).kind,
    ).toBe("connect");
  });

  it("asks for the sign-in before making a subscription model the default", () => {
    expect(
      modelSaveAction({
        tokenSource: "subscription",
        apiKey: "",
        acceptsKey: false,
        needsSignIn: true,
        signedIn: false,
      }).kind,
    ).toBe("blocked");
    expect(
      modelSaveAction({
        tokenSource: "subscription",
        apiKey: "",
        acceptsKey: false,
        needsSignIn: true,
        signedIn: true,
      }).kind,
    ).toBe("default");
  });

  it("uses the plan without touching credentials", () => {
    expect(modelSaveAction({ ...base, tokenSource: "plan", apiKey: "" }).kind).toBe("plan");
  });

  it("asks for a local URL instead of an API key", () => {
    expect(modelSaveAction({ ...base, tokenSource: "local", apiKey: "" })).toEqual({
      kind: "blocked",
      message:
        "Cole a URL do modelo local (ex. http://127.0.0.1:11434) para continuar, ou toque em “Pular por agora”.",
    });
    expect(
      modelSaveAction({ ...base, tokenSource: "local", apiKey: "http://127.0.0.1:11434" }).kind,
    ).toBe("connect");
  });
});

describe("machineNotice", () => {
  it("never says a choice took effect while the process runs elsewhere", () => {
    const notice = machineNotice({ chosen: "e2b", running: "docker", saved: "e2b" });
    expect(notice?.tone).toBe("warn");
    expect(notice?.text).toContain("ainda roda em docker");
  });

  it("says it is live only when health reports the chosen machine", () => {
    const notice = machineNotice({ chosen: "e2b", running: "e2b", saved: "e2b" });
    expect(notice?.tone).toBe("ok");
    expect(notice?.text).toContain("e2b");
  });

  it("states the running machine before anything is saved", () => {
    const notice = machineNotice({ chosen: "e2b", running: "docker", saved: null });
    expect(notice?.tone).toBe("info");
    expect(notice?.text).toContain("Nada muda até você salvar");
  });

  it("stays quiet when the choice already matches the running machine", () => {
    expect(machineNotice({ chosen: "docker", running: "docker", saved: null })).toBeNull();
  });

  it("treats a changed selection as unsaved again", () => {
    const notice = machineNotice({ chosen: "box", running: "docker", saved: "e2b" });
    expect(notice?.tone).toBe("info");
  });

  it("treats a VPS recipe as live once the remote supervisor is saved", () => {
    const notice = machineNotice({
      chosen: "vps-hetzner",
      running: "remote-supervisor",
      saved: "remote-supervisor",
    });
    expect(notice?.tone).toBe("ok");
  });
});
