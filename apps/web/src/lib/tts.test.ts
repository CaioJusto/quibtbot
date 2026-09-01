import { describe, expect, it } from "vitest";
import { speakableText } from "./tts.js";

describe("speakableText", () => {
  it("troca blocos de código por um aviso curto", () => {
    const input = "Olha o script:\n\n```bash\nls -la\nrm arquivo\n```\n\nPronto.";
    const output = speakableText(input);
    expect(output).toContain("(trecho de código)");
    expect(output).not.toContain("ls -la");
  });

  it("mantém só o rótulo de links e imagens", () => {
    expect(speakableText("Veja [o painel](https://exemplo.com/x?y=1).")).toBe("Veja o painel.");
    expect(speakableText("![captura da tela](https://exemplo.com/a.png)")).toBe("captura da tela");
  });

  it("remove a pontuação estrutural do Markdown", () => {
    const input = "# Título\n\n- item **forte**\n- outro _leve_\n\n> citação\n\n---";
    const output = speakableText(input);
    expect(output).not.toMatch(/[#*_>-]\s/);
    expect(output).toContain("item forte");
    expect(output).toContain("citação");
  });

  it("desfaz crases e tabelas sem perder o conteúdo", () => {
    const input = "Use `pnpm dev`.\n\n| coluna | valor |\n| --- | --- |\n| a | 1 |";
    const output = speakableText(input);
    expect(output).toContain("pnpm dev");
    expect(output).not.toContain("|");
  });

  it("devolve vazio para texto sem nada a falar", () => {
    expect(speakableText("```\ncode\n```")).toBe("(trecho de código)");
    expect(speakableText("   \n\n  ")).toBe("");
  });
});
