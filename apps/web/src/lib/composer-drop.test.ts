import { describe, expect, it } from "vitest";
import { filesFromTransfer, transferHasFiles } from "./composer-drop";

const png = { name: "print.png" } as unknown as File;

describe("arquivo arrastado ou colado", () => {
  it("lê a lista direta do soltar", () => {
    expect(filesFromTransfer({ files: [png] })).toEqual([png]);
  });

  it("lê o print colado, que vem por items e não por files", () => {
    expect(
      filesFromTransfer({
        files: [],
        items: [
          { kind: "string", getAsFile: () => null },
          { kind: "file", getAsFile: () => png },
        ],
      }),
    ).toEqual([png]);
  });

  it("colar texto comum não vira anexo", () => {
    expect(filesFromTransfer({ files: [], items: [{ kind: "string" }], types: ["text/plain"] }));
    expect(filesFromTransfer({ files: [], items: [{ kind: "string" }] })).toEqual([]);
    expect(filesFromTransfer(null)).toEqual([]);
  });

  it("descarta item que diz ser arquivo mas não entrega nada", () => {
    expect(filesFromTransfer({ items: [{ kind: "file", getAsFile: () => null }] })).toEqual([]);
    expect(filesFromTransfer({ items: [{ kind: "file" }] })).toEqual([]);
  });

  it("reconhece o arrastar antes de soltar, quando os bytes ainda não vieram", () => {
    // É este o caso que acende a moldura: durante o dragover o navegador esconde os bytes.
    expect(transferHasFiles({ files: [], items: [], types: ["Files"] })).toBe(true);
    expect(transferHasFiles({ files: [], items: [{ kind: "file" }] })).toBe(true);
    expect(transferHasFiles({ files: [png] })).toBe(true);
  });

  it("arrastar texto selecionado de outra aba não acende a moldura", () => {
    expect(
      transferHasFiles({ files: [], items: [{ kind: "string" }], types: ["text/plain"] }),
    ).toBe(false);
    expect(transferHasFiles(null)).toBe(false);
  });
});
