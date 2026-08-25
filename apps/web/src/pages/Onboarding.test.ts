import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "Onboarding.tsx"),
  "utf8",
);

describe("onboarding wiring", () => {
  it("takes the edition from the server instead of guessing from billing", () => {
    expect(src).toContain("resolveOnboardingFlow({ health, me, billing: snap })");
    expect(src).not.toMatch(/snap\?\.enabled \? "cloud" : "oss"/);
  });

  it("reads the machine screen state back from the API", () => {
    expect(src).toContain("setSavedMachine(settings.sandboxProvider)");
    expect(src).toContain("const health = await rpc.health()");
    expect(src).toContain("machineNotice({ chosen: machine, running: runningSandbox");
    // No hardcoded claim about what happened: every line of the notice is derived.
    expect(src).not.toContain("Este processo ainda está em");
  });

  it("guards both save buttons against a second click", () => {
    expect(src).toContain("if (savingModel) return;");
    expect(src).toContain("if (savingMachine) return;");
  });

  it("offers a way out when the first load fails", () => {
    expect(src).toContain("setLoadFailed(true)");
    expect(src).toContain("Tentar de novo");
  });

  it("ignores an older StrictMode load after a newer onboarding load wins", () => {
    expect(src).toContain("const requestId = ++loadRequestRef.current");
    expect(src).toContain("if (requestId !== loadRequestRef.current) return;");
  });

  it("returns every new onboarding step to the top", () => {
    expect(src).toContain("resetOnboardingScroll(stageRef.current)");
    expect(src).toContain("document.scrollingElement.scrollTop = 0");
    expect(src).toContain("}, [step]);");
  });

  it("keeps the OSS first-step heading the e2e helper waits for", () => {
    expect(src).toContain("Qual modelo seus bots usam?");
    expect(src).toContain("Pular por agora");
    expect(src).toContain("Manter o padrão");
    expect(src).toContain("Crie seu primeiro bot.");
  });

  it("goes straight to the decisions: no introduction screens, no dead question step", () => {
    // A tela de entrada já contou o que o produto faz; repetir em três telas só atrasava.
    expect(src).not.toContain("introSeen");
    expect(src).not.toContain("OnboardingIntro");
    expect(src).not.toContain('"questions"');
    expect(src).not.toContain("/quibt-onboarding-workflows.png");
  });

  it("sizes the progress bar by the steps this deploy really has", () => {
    expect(src).toContain("flowLength(edition, machineStep)");
    expect(src).toContain("flowPosition(step, machineStep, edition)");
  });

  it("uses the same generated character family as mobile", () => {
    expect(src).toContain(
      '{ name: "Quib", title: "Assistente", color: "#5B7FE5", shape: "strobi" }',
    );
    expect(src).toContain('{ name: "FINN", title: "Eng", color: "#8B5CF6", shape: "cubee" }');
    expect(src).toContain(
      '{ name: "Sinclair", title: "Pesquisa", color: "#14B8A6", shape: "nova" }',
    );
    expect(src).toContain('{ name: "Cecil", title: "Operações", color: "#F59E0B", shape: "onee" }');
    expect(src).not.toContain('shape: "grok"');
    expect(src).not.toContain('shape: "freddy"');
  });

  it("lets the owner pick Docker, VPS, E2B or Box and test the choice", () => {
    expect(src).toContain("O quadro abaixo diz o que instalar e o que");
    expect(src).toContain("MachineGuide");
    expect(src).toContain("probeMachine");
    expect(src).toContain("machineCredentialsReady");
    expect(src).toContain("Testar");
  });

  it("confirms Docker neste aparelho instead of skipping the machine step", () => {
    expect(src).toContain("Docker neste aparelho");
    expect(src).toContain("machineStepNeeded({ sandbox: runningSandbox })");
  });
});
