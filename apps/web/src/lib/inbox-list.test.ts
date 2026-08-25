import { describe, expect, it } from "vitest";
import {
  hiddenBotCount,
  hiddenToggleLabel,
  revealsHidden,
  visibleInboxBots,
} from "./inbox-list.js";

function bot(
  patch: Partial<{ id: string; name: string; title: string; preview: string; hidden: boolean }>,
) {
  return { id: "b", name: "", title: "", preview: "", ...patch };
}

const bots = [
  bot({ id: "b1", name: "Ada", preview: "deck" }),
  bot({ id: "b2", name: "Cecil", hidden: true, preview: "relatório" }),
  bot({ id: "b3", name: "Finn", hidden: true, preview: "deploy" }),
];

describe("hiddenBotCount", () => {
  it("counts every hidden bot when nothing is being searched", () => {
    expect(hiddenBotCount(bots, "")).toBe(2);
    expect(hiddenBotCount(bots, "   ")).toBe(2);
  });

  it("only counts the hidden bots the current search would reveal", () => {
    // "Mostrar 2 bots ocultos" while the filter can show one of them is a lie.
    expect(hiddenBotCount(bots, "cec")).toBe(1);
    expect(hiddenBotCount(bots, "ada")).toBe(0);
  });

  it("matches on the preview and the title too, like the rows do", () => {
    expect(hiddenBotCount(bots, "deploy")).toBe(1);
  });
});

describe("revealsHidden", () => {
  it("keeps revealing while there is something hidden", () => {
    expect(revealsHidden(true, 2)).toBe(true);
  });

  it("drops the stuck reveal once the last hidden bot came back", () => {
    // Otherwise the next bot the user hides stays on screen with no way to hide it.
    expect(revealsHidden(true, 0)).toBe(false);
  });
});

describe("visibleInboxBots", () => {
  it("hides hidden bots unless the toggle is on", () => {
    expect(visibleInboxBots(bots, false).map((b) => b.id)).toEqual(["b1"]);
    expect(visibleInboxBots(bots, true)).toHaveLength(3);
  });
});

describe("hiddenToggleLabel", () => {
  it("agrees in number with the count it promises", () => {
    expect(hiddenToggleLabel(false, 1)).toBe("Mostrar 1 bot oculto");
    expect(hiddenToggleLabel(false, 2)).toBe("Mostrar 2 bots ocultos");
    expect(hiddenToggleLabel(true, 2)).toBe("Ocultar bots escondidos");
  });
});
