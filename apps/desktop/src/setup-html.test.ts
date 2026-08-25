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
  });
});
