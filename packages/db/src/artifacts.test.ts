import { describe, expect, it } from "vitest";
import { isImage, MAX_ARTIFACT_BYTES, safeName } from "./artifacts.js";

describe("arquivos do fio", () => {
  it("guarda só o nome, sem caminho", () => {
    expect(safeName("/home/quibt/relatorio.pdf")).toBe("relatorio.pdf");
    expect(safeName("C:\\Users\\caio\\planilha.xlsx")).toBe("planilha.xlsx");
  });

  it("tira caracteres de controle, que sujam o cabeçalho do download", () => {
    expect(safeName("nota\u0000\u001bde voz.webm")).toBe("notade voz.webm");
    expect(safeName("\u007f")).toBe("arquivo");
  });

  it("não deixa o nome vazio nem sem fim", () => {
    expect(safeName("   ")).toBe("arquivo");
    expect(safeName("a".repeat(400))).toHaveLength(120);
  });

  it("sabe o que dá para mostrar inteiro no fio", () => {
    expect(isImage("image/png")).toBe(true);
    expect(isImage("image/webp")).toBe(true);
    expect(isImage("application/pdf")).toBe(false);
    // SVG é imagem, mas abre como documento: fica de fora do que se mostra inline.
    expect(isImage("image/svg+xml")).toBe(false);
  });

  it("o teto cabe um print, um PDF e uma planilha", () => {
    expect(MAX_ARTIFACT_BYTES).toBe(25 * 1024 * 1024);
  });
});
