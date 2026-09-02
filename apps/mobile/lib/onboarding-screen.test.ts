import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const screen = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../app/onboarding.tsx"),
  "utf8",
);

describe("mobile onboarding screen", () => {
  it("waits for the edition before painting a step", () => {
    expect(screen).toContain("resolveEdition({ health, billing: snap })");
    expect(screen).toContain("if (!edition)");
    // A etapa da máquina some quando o servidor já diz que tem computador de pé.
    expect(screen).toContain(
      "setStep(productSteps(next, choose, owner, health?.sandbox ?? null)[0])",
    );
  });

  it("derives the step list and the back arrow from the edition", () => {
    expect(screen).toContain("const steps = productSteps(");
    expect(screen).toContain("previousStep()");
    expect(screen).toContain("{stepIndex + 1}/{steps.length}");
    expect(screen).not.toContain("STEP_ORDER");
  });

  it("starts with the model step and supports OpenRouter, local and subscription", () => {
    expect(screen).toContain('step === "model"');
    expect(screen).toContain("modelSaveAction");
    expect(screen).toContain("Chave OpenRouter");
    expect(screen).toContain("Modelo local");
    expect(screen).toContain("Pular por agora");
    expect(screen).toContain("models/connect");
  });

  it("põe a assinatura e a CLI antes da chave e do modelo local", () => {
    const subscription = screen.indexOf('title="Minha assinatura"');
    const cli = screen.indexOf('title="CLI no host"');
    const key = screen.indexOf('title="Chave OpenRouter"');
    const local = screen.indexOf('title="Modelo local"');
    expect(subscription).toBeGreaterThan(-1);
    expect(subscription).toBeLessThan(cli);
    expect(cli).toBeLessThan(key);
    expect(key).toBeLessThan(local);
    // O cartão que começa marcado segue a mesma regra do web (@quibt/core).
    expect(screen).toContain("initialTokenSource({");
    expect(screen).toContain("Claude Code, Codex, Grok ou ACP extra");
    expect(screen).toContain('rpc("models/connectCli"');
  });

  it("diz onde a chave OpenRouter nasce e quem paga", () => {
    expect(screen).toContain('Linking.openURL("https://openrouter.ai/keys")');
    expect(screen).toContain("Você paga por uso na sua conta OpenRouter");
  });

  it("lets the owner pick Docker, VPS, E2B, Box or Daytona before the first bot", () => {
    expect(screen).toContain("MachineSettingsBody");
    expect(screen).toContain('step === "machine"');
  });

  it("never sells a plan: the app ships only the open source path", () => {
    expect(screen).not.toContain("PlanStep");
    expect(screen).not.toContain("willCheckout");
    expect(screen).not.toContain("billing/checkout");
    expect(screen).not.toContain("Beta gratuito");
    expect(screen).toContain('item !== "plan"');
  });
});
