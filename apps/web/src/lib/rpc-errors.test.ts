import { describe, expect, it } from "vitest";

import { errorMessage } from "./rpc-errors.js";

describe("errorMessage", () => {
  it("troca o código cru do oRPC por uma frase que diz o que fazer", () => {
    expect(errorMessage(new Error("FORBIDDEN"), "fallback")).toContain("instalou o Quibt");
    expect(errorMessage(new Error("Forbidden"), "fallback")).toContain("instalou o Quibt");
    expect(errorMessage(new Error("TOO MANY REQUESTS"), "fallback")).toContain(
      "Espere um instante",
    );
  });

  it("mantém a mensagem que o servidor escreveu", () => {
    expect(errorMessage(new Error("O Docker não respondeu na porta 7091."), "fallback")).toBe(
      "O Docker não respondeu na porta 7091.",
    );
  });

  it("usa o texto de reserva para um código que ainda não tem tradução", () => {
    expect(errorMessage(new Error("BAD_GATEWAY"), "Não deu certo")).toBe("Não deu certo");
    expect(errorMessage(new Error("   "), "Não deu certo")).toBe("Não deu certo");
    expect(errorMessage("não é um Error", "Não deu certo")).toBe("Não deu certo");
  });

  it("keeps the honest missing-model and computer-boot phrases", () => {
    expect(
      errorMessage(
        new Error(
          "Nao tenho um modelo conectado. Cole uma chave em Conta, ou volte no onboarding.",
        ),
        "x",
      ),
    ).toMatch(/Nao tenho um modelo|Não tenho um modelo/);
    expect(
      errorMessage(
        new Error("O computador nao ligou: o Docker recusou o processo (EAGAIN). Tente de novo."),
        "x",
      ),
    ).toMatch(/computador n.o ligou/);
  });
});
