import { describe, expect, it } from "vitest";
import { lessonIsEmpty, lessonPrompt } from "./lesson.js";

const empty = { urls: [], commands: [], files: [], windows: [] };

describe("lessonIsEmpty", () => {
  it("ignores open windows: a window alone is not something taught", () => {
    expect(lessonIsEmpty({ ...empty, windows: ["Chromium"] })).toBe(true);
    expect(lessonIsEmpty({ ...empty, urls: ["https://x"] })).toBe(false);
    expect(lessonIsEmpty({ ...empty, commands: ["ls"] })).toBe(false);
  });
});

describe("lessonPrompt", () => {
  it("leads with the person's own words and asks for save_skill", () => {
    const prompt = lessonPrompt("baixo o extrato e mando pro contador", {
      ...empty,
      urls: ["Banco — https://banco.exemplo/extrato"],
      commands: ["ls ~/Downloads"],
    });
    expect(prompt).toContain("baixo o extrato e mando pro contador");
    expect(prompt).toContain("- Banco — https://banco.exemplo/extrato");
    expect(prompt).toContain("- ls ~/Downloads");
    expect(prompt).toContain("save_skill");
    // A captura é apoio: um clique errado não pode virar passo do método.
    expect(prompt).toContain("ignore e escreva o jeito certo");
  });

  it("still works when the person wrote nothing", () => {
    const prompt = lessonPrompt("   ", empty);
    expect(prompt).toContain("fazendo ela uma vez na sua tela");
    expect(prompt).toContain("save_skill");
  });

  it("leaves out sections that have nothing in them", () => {
    const prompt = lessonPrompt("abrir o painel", { ...empty, urls: ["https://x"] });
    expect(prompt).toContain("Páginas que abri");
    expect(prompt).not.toContain("Comandos que rodei");
    expect(prompt).not.toContain("Arquivos que mexi");
  });
});
