import type { MessageBlock } from "@quibt/contracts";
import { describe, expect, it } from "vitest";
import { blocksToText } from "./executor.js";

describe("blocksToText (como um recado antigo entra no histórico do modelo)", () => {
  it("narra um card de aprovação em vez de repetir o texto da tela", () => {
    // O caso real: quatro cards "Preciso da sua aprovação" no fio viravam quatro linhas
    // iguais de fala do assistente, e o modelo passou a repeti-las sem chamar ferramenta.
    const blocks: MessageBlock[] = [
      {
        kind: "ask",
        text: "Preciso da sua aprovação",
        tool: "shell",
        detail: "xdg-open https://g1.globo.com",
        answered: "allow",
        requestId: "r:1",
      },
    ];
    const text = blocksToText(blocks);
    expect(text).toBe(
      "[pediu aprovação para shell: xdg-open https://g1.globo.com — permitido pelo usuário]",
    );
    expect(text).not.toContain("Preciso da sua aprovação");
    expect(
      blocksToText([
        {
          kind: "ask",
          text: "Preciso da sua aprovação",
          tool: "shell",
          detail: "rm -rf x",
          answered: "deny",
        },
      ]),
    ).toContain("recusado pelo usuário");
    expect(blocksToText([{ kind: "ask", text: "Posso continuar?", requestId: "r:2" }])).toBe(
      "[Posso continuar? — sem resposta]",
    );
  });

  it("narra um arquivo enviado em vez de despejar o JSON do bloco", () => {
    const text = blocksToText([
      {
        kind: "file",
        artifactId: "art_1",
        name: "quibt-screenshot-1.png",
        mimeType: "image/png",
        size: 50329,
        image: true,
        caption: "Aqui está o print da tela do G1!",
      },
      { kind: "text", text: "Se precisar de mais algo, é só avisar!" },
    ]);
    expect(text).toBe(
      "[enviou a imagem quibt-screenshot-1.png — Aqui está o print da tela do G1!]\nSe precisar de mais algo, é só avisar!",
    );
    expect(text).not.toContain("{");
  });

  it("keeps plain text, cards and choices readable", () => {
    expect(blocksToText([{ kind: "text", text: "oi" }])).toBe("oi");
    expect(
      blocksToText([
        {
          kind: "card",
          lines: [
            { k: "Status", v: "ok" },
            { k: "Fila", v: "3" },
          ],
        },
      ]),
    ).toBe("Status: ok\nFila: 3");
    expect(
      blocksToText([
        {
          kind: "choice",
          question: "Qual?",
          options: [{ id: "a", letter: "A", label: "Primeira" }],
        },
      ]),
    ).toBe("Qual?\nA) Primeira");
  });
});

describe("sandboxCwd (o diretório que o modelo pede para um comando)", () => {
  it("turns whatever the model sends into an absolute path inside the bot's home", async () => {
    const { sandboxCwd } = await import("./executor.js");
    expect(sandboxCwd(undefined)).toBe("/home/quibt");
    expect(sandboxCwd("~/")).toBe("/home/quibt");
    expect(sandboxCwd("~")).toBe("/home/quibt");
    expect(sandboxCwd("~/Downloads")).toBe("/home/quibt/Downloads");
    expect(sandboxCwd("./projeto")).toBe("/home/quibt/projeto");
    expect(sandboxCwd("projeto/src")).toBe("/home/quibt/projeto/src");
    expect(sandboxCwd("/home/user")).toBe("/home/quibt");
    expect(sandboxCwd("/home/user/docs/")).toBe("/home/quibt/docs");
    expect(sandboxCwd("/Users/caio/x")).toBe("/home/quibt/x");
    expect(sandboxCwd("/home/quibt/work")).toBe("/home/quibt/work");
    expect(sandboxCwd("/tmp")).toBe("/tmp");
    expect(sandboxCwd("/")).toBe("/");
  });
});
