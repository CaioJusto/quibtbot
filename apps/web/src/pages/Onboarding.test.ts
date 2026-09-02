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

  it("introduces team packs, spoken replies and groups before the first bot opens", () => {
    expect(src).toContain("Importe um time inteiro de um arquivo Markdown.");
    expect(src).toContain("O bot pode ler as respostas em voz alta.");
    expect(src).toContain("Crie um grupo para os bots trabalharem juntos.");
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

  it("lets the owner pick Docker, VPS, E2B, Box or Daytona and test the choice", () => {
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

describe("etapa do modelo", () => {
  it("põe assinatura, CLI detectada, chave OpenRouter e modelo local", () => {
    const subscription = src.indexOf('title="Minha assinatura"');
    const cli = src.indexOf('title="CLI no host"');
    const key = src.indexOf('title="Chave OpenRouter"');
    const local = src.indexOf('title="Modelo local"');
    expect(subscription).toBeGreaterThan(-1);
    expect(subscription).toBeLessThan(cli);
    expect(cli).toBeLessThan(key);
    expect(key).toBeLessThan(local);
    // E o cartão que começa marcado segue a mesma ordem.
    expect(src).toContain("initialTokenSource({");
  });

  it("separa login do app das CLIs já autenticadas no host", () => {
    expect(src).toContain("Nenhuma CLI Claude Code, Codex, Grok ou ACP extra");
    expect(src).toContain("ChatGPT Plus/Pro, Copilot ou SuperGrok");
    expect(src).toContain('entry.signIn === "device-code"\n    ? "Entre com a assinatura');
  });

  it("ativa a CLI sem chave e explica onde ela roda", () => {
    expect(src).toContain("rpc.models.connectCli");
    expect(src).toContain("host da API/worker");
    expect(src).toContain("Não é preciso colar chave");
  });

  it("diz onde a chave OpenRouter nasce e quem paga", () => {
    expect(src).toContain('href="https://openrouter.ai/keys"');
    expect(src).toContain("Você paga por uso na sua conta OpenRouter");
  });

  it("mostra a recusa do provedor junto do campo e confirma a chave boa", () => {
    expect(src).toContain('setKeyStatus({ kind: "ok", verified })');
    // A frase vem do core: "confirmada" só quando o servidor sondou o provedor.
    expect(src).toContain("connectedModelNotice({");
    expect(src).toContain('kind: "error",');
    expect(src).toContain("Não foi possível confirmar a chave");
    // A recusa não vira o erro genérico do rodapé nem avança a etapa.
    expect(src).toContain(
      "setKeyStatus(null);\n          let verified = false;\n          try {\n            const credential = await rpc.models.connect({",
    );
  });
});
