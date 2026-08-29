import { describe, expect, it } from "vitest";
import { withDesktopRetryHint } from "./install-messages.js";

describe("withDesktopRetryHint", () => {
  it("troca a instrução neutra do pacote pelo nome do botão da tela", () => {
    expect(
      withDesktopRetryHint(
        "O download de quibt-computer:0.2.15 falhou 3 vezes (a internet caiu). Confira a internet e rode a instalação de novo — o que já baixou fica guardado.",
      ),
    ).toBe(
      "O download de quibt-computer:0.2.15 falhou 3 vezes (a internet caiu). Confira a internet e clique em Começar instalação de novo — o que já baixou fica guardado.",
    );
    expect(
      withDesktopRetryHint(
        "O Docker Desktop não está mais instalado neste computador. Rode a instalação de novo para o Quibt baixar o Docker.",
      ),
    ).toBe(
      "O Docker Desktop não está mais instalado neste computador. Clique em Começar instalação para o Quibt baixar o Docker.",
    );
  });

  it("não mexe no que não fala de instalar de novo", () => {
    const update =
      "Este computador tem o Quibt Bot 0.2.10 instalado e este instalador é o 0.2.15. Rode a atualização (quibtbot update) em vez de instalar de novo.";
    expect(withDesktopRetryHint(update)).toBe(update);
    expect(withDesktopRetryHint("A porta 5173 já está em uso.")).toBe(
      "A porta 5173 já está em uso.",
    );
  });
});
