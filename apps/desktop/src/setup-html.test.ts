import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const setupHtml = readFileSync(path.resolve(import.meta.dirname, "../setup.html"), "utf8");

describe("desktop setup navigation", () => {
  it("opens the local installation flow from the primary choice", () => {
    expect(setupHtml).toContain(
      'document.getElementById("choose-local")?.addEventListener("click"',
    );
    expect(setupHtml).toContain('show("local")');
  });

  it("uses the Quibt visual system and keeps form controls accessible", () => {
    expect(setupHtml).toContain('src="./quibt-team.png"');
    expect(setupHtml).toContain("mode-card--primary");
    expect(setupHtml).toContain('<section class="setup-pane">');
    expect(setupHtml).toContain("background: transparent;");
    expect(setupHtml).not.toContain('<section class="card">');
    expect(setupHtml).toContain('input:not([type="checkbox"])');
    expect(setupHtml).toContain(":focus-visible");
    expect(setupHtml).toContain('ok === true ? "ok" : ok === false ? "bad" : "working"');
    expect(setupHtml).toContain("startButton.disabled = true");
    expect(setupHtml).toContain("startButton.disabled = false");
    expect(setupHtml).toContain('id="local-pairing"');
    expect(setupHtml).toContain('id="open-after-install"');
    expect(setupHtml).toContain("desktop.completeLocalPairing?.()");
    expect(setupHtml).toContain(
      "A instalação remota será liberada quando o manifesto deste release estiver pronto.",
    );
  });

  it("religa um stack já instalado sozinho, com estado 'Ligando' e botão de tentar de novo", () => {
    expect(setupHtml).toContain("desktop?.autoStartPending?.()");
    expect(setupHtml).toContain("runLocalStack({ auto: true })");
    expect(setupHtml).toContain("Ligando o Quibt Bot…");
    expect(setupHtml).toContain('id="starting-step"');
    expect(setupHtml).toContain('class="spinner"');
    expect(setupHtml).toContain("Leva cerca de um minuto na primeira vez depois de ligar o");
    expect(setupHtml).toContain('"Tentar de novo"');
    // Falhou: o erro real aparece, os detalhes voltam e o botão de tentar de novo também.
    expect(setupHtml).toContain("else if (!result.ok && auto)");
  });

  it("desenha a barra do download a partir do campo progress dos eventos", () => {
    expect(setupHtml).toContain('id="pull-progress"');
    expect(setupHtml).toContain('id="pull-progress-fill"');
    expect(setupHtml).toContain("if (event.progress) renderPullProgress(event.progress)");
    expect(setupHtml).toContain("(index - 1 + fraction) / count");
    expect(setupHtml).toContain("camadas");
    // O rótulo curto vem pronto do instalador: a referência crua tem 64 caracteres de
    // digest e quebra a linha.
    expect(setupHtml).toContain("const { image, label, index, count, layersDone, layersTotal }");
    expect(setupHtml).toContain("label ||");
  });

  it("religando sozinho, não arranca a tela de quem foi para outro servidor", () => {
    // O Voltar some enquanto liga, e o resultado só navega se a tela local continua na
    // frente — senão o formulário do servidor remoto sumiria no meio da digitação.
    expect(setupHtml).toContain("if (backLocal) backLocal.hidden = true;");
    expect(setupHtml).toContain("if (backLocal) backLocal.hidden = false;");
    expect(setupHtml).toContain('if (!localView.classList.contains("hidden")) {');
  });

  it("sem o Docker instalado, volta ao modo instalação com botão e termos", () => {
    expect(setupHtml).toContain("if (result.needsInstall)");
    expect(setupHtml).toContain("setStartingMode(false);");
  });
});
