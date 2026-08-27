import { describe, expect, it } from "vitest";
import {
  CSV_MAX_COLUMNS,
  CSV_MAX_ROWS,
  csvTableNote,
  detectDelimiter,
  isSpreadsheetFile,
  parseCsvTable,
} from "./csv-table.js";

describe("isSpreadsheetFile (o que vira tabela)", () => {
  it("aceita csv e tsv pelo tipo e pela extensão", () => {
    expect(isSpreadsheetFile("text/csv")).toBe(true);
    expect(isSpreadsheetFile("text/csv; charset=utf-8")).toBe(true);
    expect(isSpreadsheetFile("application/octet-stream", "vendas.CSV")).toBe(true);
    expect(isSpreadsheetFile(undefined, "notas.tsv?v=2")).toBe(true);
  });

  it("deixa o resto no visualizador de texto ou no download", () => {
    expect(isSpreadsheetFile("text/plain", "leia.txt")).toBe(false);
    expect(isSpreadsheetFile("application/json", "dados.json")).toBe(false);
    expect(
      isSpreadsheetFile(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "planilha.xlsx",
      ),
    ).toBe(false);
  });
});

describe("detectDelimiter", () => {
  it("acha o ponto e vírgula do Excel brasileiro", () => {
    expect(detectDelimiter("nome;cidade;total\nAda;Recife;10")).toBe(";");
  });

  it("usa vírgula quando é vírgula", () => {
    expect(detectDelimiter("nome,cidade\nAda,Recife")).toBe(",");
  });

  it("não conta separador que está dentro de aspas", () => {
    expect(detectDelimiter('"Recife, PE";"São Paulo, SP";total')).toBe(";");
  });

  it("respeita a extensão .tsv mesmo com vírgulas no texto", () => {
    expect(detectDelimiter("cidade\ttexto\nRecife\tum, dois, três", "notas.tsv")).toBe("\t");
  });
});

describe("parseCsvTable", () => {
  it("separa cabeçalho e linhas", () => {
    const table = parseCsvTable("nome,cidade\nAda,Recife\nFinn,Olinda");
    expect(table?.header).toEqual(["nome", "cidade"]);
    expect(table?.rows).toEqual([
      ["Ada", "Recife"],
      ["Finn", "Olinda"],
    ]);
    expect(table?.totalRows).toBe(2);
  });

  it("aspas seguram vírgula, quebra de linha e aspas dobradas", () => {
    const table = parseCsvTable('nome,nota\n"Ada, a primeira","disse ""oi""\nna segunda linha"');
    expect(table?.rows[0]).toEqual(["Ada, a primeira", 'disse "oi"\nna segunda linha']);
  });

  it("lê arquivo com quebra do Windows e ignora a quebra final", () => {
    const table = parseCsvTable("a,b\r\n1,2\r\n");
    expect(table?.rows).toEqual([["1", "2"]]);
    expect(table?.totalRows).toBe(1);
  });

  it("completa a linha curta para o cabeçalho não desalinhar", () => {
    const table = parseCsvTable("a,b,c\n1,2");
    expect(table?.rows[0]).toEqual(["1", "2", ""]);
  });

  it("não fabrica tabela de uma coluna só", () => {
    expect(parseCsvTable("uma linha de texto\noutra linha")).toBeNull();
    expect(parseCsvTable("")).toBeNull();
  });

  it("corta em CSV_MAX_ROWS mas conta o arquivo inteiro", () => {
    const lines = ["a,b", ...Array.from({ length: CSV_MAX_ROWS + 40 }, (_, i) => `${i},x`)];
    const table = parseCsvTable(lines.join("\n"));
    expect(table?.rows.length).toBe(CSV_MAX_ROWS);
    expect(table?.totalRows).toBe(CSV_MAX_ROWS + 40);
  });

  it("corta em CSV_MAX_COLUMNS mas conta as colunas do arquivo", () => {
    const wide = Array.from({ length: CSV_MAX_COLUMNS + 5 }, (_, i) => `c${i}`).join(",");
    const table = parseCsvTable(`${wide}\n${wide}`);
    expect(table?.header.length).toBe(CSV_MAX_COLUMNS);
    expect(table?.totalColumns).toBe(CSV_MAX_COLUMNS + 5);
  });
});

describe("csvTableNote (a legenda não mente)", () => {
  it("diz o tamanho e o separador quando cabe tudo", () => {
    const table = parseCsvTable("a;b\n1;2\n3;4");
    expect(csvTableNote(table!)).toBe("2 linhas · separado por ponto e vírgula");
  });

  it("avisa o que ficou de fora quando não cabe", () => {
    const lines = ["a,b", ...Array.from({ length: CSV_MAX_ROWS + 1 }, () => "1,2")];
    const note = csvTableNote(parseCsvTable(lines.join("\n"))!);
    expect(note).toContain(`mostrando as ${CSV_MAX_ROWS} primeiras`);
    expect(note).toContain("baixe o arquivo");
  });
});
