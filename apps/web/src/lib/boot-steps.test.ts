import { describe, expect, it } from "vitest";
import { type BootStep, bootFinished, bootStatusLine, bootSteps } from "./boot-steps.js";

function shape(steps: BootStep[]) {
  return steps.map((step) => `${step.id}:${step.state}`);
}

describe("bootSteps (o passo tem nome, não porcentagem)", () => {
  it("sem resposta ainda, só o pedido está andando", () => {
    expect(shape(bootSteps({ state: null }))).toEqual([
      "pedido:doing",
      "maquina:waiting",
      "tela:waiting",
      "entrada:waiting",
    ]);
  });

  it("máquina subindo: o pedido já foi", () => {
    expect(shape(bootSteps({ state: "booting" }))).toEqual([
      "pedido:done",
      "maquina:doing",
      "tela:waiting",
      "entrada:waiting",
    ]);
  });

  it("máquina de pé e tela ainda não: o passo da tela anda", () => {
    expect(shape(bootSteps({ state: "running", screenAvailable: false }))).toEqual([
      "pedido:done",
      "maquina:done",
      "tela:doing",
      "entrada:waiting",
    ]);
  });

  it("tela existe mas a URL não chegou: falta só entrar", () => {
    expect(shape(bootSteps({ state: "running", screenAvailable: true, screenUrl: null }))).toEqual([
      "pedido:done",
      "maquina:done",
      "tela:done",
      "entrada:doing",
    ]);
  });

  it("com a URL na mão, nada mais está andando", () => {
    const steps = bootSteps({ state: "running", screenAvailable: true, screenUrl: "wss://x" });
    expect(steps.every((step) => step.state === "done")).toBe(true);
  });

  it("computador dormindo é acordar, não ligar", () => {
    expect(bootSteps({ state: "suspended" })[1]?.label).toBe("Acordando a máquina");
    expect(bootSteps({ state: "booting" })[1]?.label).toBe("Ligando a máquina");
  });

  it("erro marca o passo parado em vez de continuar girando", () => {
    expect(shape(bootSteps({ state: "error" }))).toEqual([
      "pedido:done",
      "maquina:failed",
      "tela:waiting",
      "entrada:waiting",
    ]);
  });
});

describe("bootFinished", () => {
  it("só termina quando a tela está mesmo aberta", () => {
    expect(bootFinished({ state: "running", screenAvailable: true, screenUrl: "wss://x" })).toBe(
      true,
    );
    expect(bootFinished({ state: "running", screenAvailable: true })).toBe(false);
    expect(bootFinished({ state: "booting" })).toBe(false);
    expect(bootFinished({ state: "error" })).toBe(false);
  });
});

describe("bootStatusLine", () => {
  it("acompanha o passo em vez de repetir a mesma frase", () => {
    expect(bootStatusLine({ state: "booting" })).toBe("Ligando a máquina…");
    expect(bootStatusLine({ state: "running", screenAvailable: false })).toBe(
      "Preparando a tela do bot…",
    );
    expect(bootStatusLine({ state: "error" })).toBe("O computador não conseguiu ligar.");
    expect(bootStatusLine({ state: "running", screenAvailable: true, screenUrl: "wss://x" })).toBe(
      "Tela pronta.",
    );
  });
});
