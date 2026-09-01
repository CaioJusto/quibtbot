import { describe, expect, it } from "vitest";
import {
  buildPaletteItems,
  filterPalette,
  messagePaletteItems,
  moveHighlight,
  normalizeQuery,
  opensPalette,
  type PaletteItem,
  scoreTerm,
} from "./command-palette.js";

const items: PaletteItem[] = [
  { id: "bot:1", label: "João", detail: "Cuida da agenda", action: { kind: "bot", id: "1" } },
  { id: "bot:2", label: "Ana Lúcia", detail: "Financeiro", action: { kind: "bot", id: "2" } },
  {
    id: "action:create",
    label: "Criar um bot",
    keywords: ["novo"],
    action: { kind: "panel", panel: "create" },
  },
];

describe("normalizeQuery", () => {
  it("drops accents and punctuation", () => {
    expect(normalizeQuery("João, tudo bem?")).toBe("joao tudo bem");
    expect(normalizeQuery("  Ação —  Rápida ")).toBe("acao rapida");
  });

  it("returns an empty string when nothing is searchable", () => {
    expect(normalizeQuery("  --  ")).toBe("");
  });
});

describe("scoreTerm", () => {
  it("rejects letters that are not there in order", () => {
    expect(scoreTerm("criar um bot", "xyz")).toBeNull();
    expect(scoreTerm("criar um bot", "tob")).toBeNull();
  });

  it("rewards the start of a word over the middle of one", () => {
    const start = scoreTerm("bot novo", "bot");
    const middle = scoreTerm("robot antigo", "bot");
    expect(start).not.toBeNull();
    expect(middle).not.toBeNull();
    expect(start as number).toBeGreaterThan(middle as number);
  });

  it("matches an empty term", () => {
    expect(scoreTerm("qualquer", "")).toBe(0);
  });
});

describe("filterPalette", () => {
  it("finds an accented name typed without accent", () => {
    expect(filterPalette(items, "joao").map((item) => item.id)).toEqual(["bot:1"]);
    expect(filterPalette(items, "lucia").map((item) => item.id)).toEqual(["bot:2"]);
  });

  it("keeps every item when the search is empty", () => {
    expect(filterPalette(items, "   ")).toHaveLength(3);
  });

  it("matches initials spread across the label", () => {
    expect(filterPalette(items, "cr bot").map((item) => item.id)).toEqual(["action:create"]);
  });

  it("requires every word of the search to match", () => {
    expect(filterPalette(items, "joao financeiro")).toEqual([]);
  });

  it("searches the support line and the hidden keywords", () => {
    expect(filterPalette(items, "agenda").map((item) => item.id)).toEqual(["bot:1"]);
    expect(filterPalette(items, "novo").map((item) => item.id)).toEqual(["action:create"]);
  });

  it("puts the closest label first", () => {
    const many: PaletteItem[] = [
      { id: "bot:a", label: "Anabela", action: { kind: "bot", id: "a" } },
      { id: "bot:b", label: "Ana", action: { kind: "bot", id: "b" } },
    ];
    expect(filterPalette(many, "ana")[0]?.id).toBe("bot:b");
  });
});

describe("moveHighlight", () => {
  it("stops at both ends instead of wrapping", () => {
    expect(moveHighlight(0, 3, -1)).toBe(0);
    expect(moveHighlight(2, 3, 1)).toBe(2);
    expect(moveHighlight(0, 3, 1)).toBe(1);
  });

  it("survives an empty list and an index left over from a longer one", () => {
    expect(moveHighlight(4, 0, 1)).toBe(0);
    expect(moveHighlight(9, 2, 1)).toBe(1);
  });
});

describe("buildPaletteItems", () => {
  it("leaves hidden bots out, like the sidebar does", () => {
    const built = buildPaletteItems(
      [
        { id: "1", name: "Ada" },
        { id: "2", name: "Oculta", hidden: true },
      ],
      [],
    );
    expect(built.some((item) => item.label === "Oculta")).toBe(false);
  });

  it("only offers the bot-scoped actions when a conversation is open", () => {
    const closed = buildPaletteItems([], [], { hasActiveBot: false }).map((item) => item.id);
    const open = buildPaletteItems([], [], { hasActiveBot: true }).map((item) => item.id);
    expect(closed).not.toContain("action:computer");
    expect(closed).toContain("action:create");
    expect(open).toContain("action:computer");
  });

  it("lists groups with their own action", () => {
    const built = buildPaletteItems([], [{ id: "g1", name: "Time" }]);
    expect(built[0]).toMatchObject({ label: "Time", action: { kind: "group", id: "g1" } });
  });
});

describe("messagePaletteItems", () => {
  it("turns a message into an action for its owning conversation", () => {
    const [item] = messagePaletteItems([
      {
        messageId: "m1",
        threadId: "t1",
        seq: 4,
        botId: null,
        groupId: "g1",
        ownerName: "Equipe",
        text: "  Decisão   da reunião  ",
        createdAt: "2026-08-27T09:00:00.000Z",
      },
    ]);
    expect(item).toMatchObject({
      id: "message:m1",
      label: "Decisão da reunião",
      detail: "Mensagem em Equipe",
      action: { kind: "message", botId: null, groupId: "g1", messageId: "m1" },
    });
  });
});

describe("opensPalette", () => {
  it("takes ⌘K and Ctrl+K, upper or lower case", () => {
    expect(opensPalette({ key: "k", metaKey: true, ctrlKey: false })).toBe(true);
    expect(opensPalette({ key: "K", metaKey: false, ctrlKey: true })).toBe(true);
  });

  it("ignores a bare k and other shortcuts", () => {
    expect(opensPalette({ key: "k", metaKey: false, ctrlKey: false })).toBe(false);
    expect(opensPalette({ key: "n", metaKey: true, ctrlKey: false })).toBe(false);
  });
});
