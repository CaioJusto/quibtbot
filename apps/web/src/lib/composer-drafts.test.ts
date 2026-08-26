import { describe, expect, it } from "vitest";
import type { Attachment } from "./attachments";
import {
  type ComposerDraft,
  clearDraft,
  conversationKey,
  type DraftMap,
  draftAt,
  draftsFromTexts,
  putDraft,
  readStoredDrafts,
  storableTexts,
  writeStoredDrafts,
} from "./composer-drafts";

const file: Attachment = { id: "a1", name: "planta.png", mimeType: "image/png", size: 10 };

function draft(patch: Partial<ComposerDraft> = {}): ComposerDraft {
  return { text: "", attachments: [], replyToId: null, ...patch };
}

/** Um localStorage de mentira, para não depender do navegador nem sujar o disco do teste. */
function fakeStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  } as Storage;
}

describe("conversationKey", () => {
  it("dá uma chave a cada conversa, e uma à caixa de entrada", () => {
    expect(conversationKey({ botId: "b1" })).toBe("bot:b1");
    expect(conversationKey({ groupId: "g1" })).toBe("group:g1");
    // Um bot pode estar na rota junto do grupo; quem está na tela é o grupo.
    expect(conversationKey({ botId: "b1", groupId: "g1" })).toBe("group:g1");
    expect(conversationKey({})).toBe("inbox");
  });
});

describe("rascunho por conversa", () => {
  it("guarda o texto de um bot sem tocar no do outro", () => {
    let drafts: DraftMap = {};
    drafts = putDraft(drafts, "bot:b1", draft({ text: "oi Cubee" }));
    drafts = putDraft(drafts, "group:g1", draft({ text: "pessoal," }));

    expect(draftAt(drafts, "bot:b1").text).toBe("oi Cubee");
    expect(draftAt(drafts, "group:g1").text).toBe("pessoal,");
    expect(draftAt(drafts, "bot:b2").text).toBe("");
  });

  it("leva anexo e recado citado junto do texto", () => {
    const drafts = putDraft({}, "bot:b1", draft({ attachments: [file], replyToId: "m9" }));
    expect(draftAt(drafts, "bot:b1")).toEqual({
      text: "",
      attachments: [file],
      replyToId: "m9",
    });
  });

  it("enviar limpa só a conversa enviada", () => {
    let drafts: DraftMap = {};
    drafts = putDraft(drafts, "bot:b1", draft({ text: "vai", attachments: [file] }));
    drafts = putDraft(drafts, "bot:b2", draft({ text: "fica" }));

    drafts = clearDraft(drafts, "bot:b1");

    expect(drafts["bot:b1"]).toBeUndefined();
    expect(draftAt(drafts, "bot:b2").text).toBe("fica");
  });

  it("apagar o que estava escrito tira a entrada do mapa em vez de deixar um vazio", () => {
    const drafts = putDraft(putDraft({}, "bot:b1", draft({ text: "x" })), "bot:b1", draft());
    expect(Object.keys(drafts)).toEqual([]);
  });
});

describe("o que sobrevive ao recarregar", () => {
  it("guarda texto e descarta anexo e citação", () => {
    const drafts = putDraft({}, "bot:b1", draft({ text: "meio da frase", attachments: [file] }));
    const storage = fakeStorage();
    writeStoredDrafts(drafts, storage);

    expect(readStoredDrafts(storage)).toEqual({
      "bot:b1": { text: "meio da frase", attachments: [], replyToId: null },
    });
  });

  it("não guarda rascunho que é só espaço em branco", () => {
    expect(storableTexts(putDraft({}, "bot:b1", draft({ text: "   " })))).toEqual({});
  });

  it("some do disco quando o último rascunho é enviado", () => {
    const storage = fakeStorage();
    writeStoredDrafts(putDraft({}, "bot:b1", draft({ text: "oi" })), storage);
    writeStoredDrafts({}, storage);
    expect(readStoredDrafts(storage)).toEqual({});
  });

  it("aguenta lixo no disco sem derrubar a abertura do app", () => {
    expect(readStoredDrafts(fakeStorage({ "quibt.composer-drafts.v1": "{{{" }))).toEqual({});
    expect(readStoredDrafts(fakeStorage({ "quibt.composer-drafts.v1": "[1,2]" }))).toEqual({});
    expect(readStoredDrafts(null)).toEqual({});
    expect(draftsFromTexts({ "bot:b1": 7, "bot:b2": "vale" })).toEqual({
      "bot:b2": { text: "vale", attachments: [], replyToId: null },
    });
  });

  it("quando é rascunho demais, quem cai é o mais antigo", () => {
    let drafts: DraftMap = {};
    for (let i = 0; i < 55; i += 1)
      drafts = putDraft(drafts, `bot:b${i}`, draft({ text: `n${i}` }));

    const stored = storableTexts(drafts);

    expect(Object.keys(stored)).toHaveLength(50);
    expect(stored["bot:b0"]).toBeUndefined();
    expect(stored["bot:b54"]).toBe("n54");
  });

  it("não deixa o disco engolir um arquivo colado inteiro", () => {
    const huge = "a".repeat(30_000);
    const stored = storableTexts(putDraft({}, "bot:b1", draft({ text: huge })));
    expect(stored["bot:b1"]?.length).toBe(20_000);
  });
});
