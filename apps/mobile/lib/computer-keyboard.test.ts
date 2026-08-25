import { describe, expect, it } from "vitest";
import {
  BACKSPACE,
  boundedStrokes,
  MAX_STROKES_PER_EDIT,
  RETURN,
  strokesForEdit,
} from "./computer-keyboard";

describe("strokesForEdit", () => {
  it("sends only what was typed", () => {
    expect(strokesForEdit("", "oi")).toEqual([{ key: "o" }, { key: "i" }]);
  });

  it("turns a deletion into backspace", () => {
    expect(strokesForEdit("oi", "o")).toEqual([{ key: BACKSPACE }]);
  });

  it("keeps the shared start instead of retyping everything", () => {
    // O corretor troca a última palavra: só ela é refeita, não a frase inteira.
    expect(strokesForEdit("bom dia", "bom dias")).toEqual([{ key: "s" }]);
    expect(strokesForEdit("bom dia", "bom noite")).toEqual([
      { key: BACKSPACE },
      { key: BACKSPACE },
      { key: BACKSPACE },
      { key: "n" },
      { key: "o" },
      { key: "i" },
      { key: "t" },
      { key: "e" },
    ]);
  });

  it("sends Return for a line break, not a stray character", () => {
    expect(strokesForEdit("", "\n")).toEqual([{ key: RETURN }]);
  });

  it("does nothing when nothing changed", () => {
    expect(strokesForEdit("igual", "igual")).toEqual([]);
  });
});

describe("boundedStrokes", () => {
  it("caps a huge paste so it does not become hundreds of calls", () => {
    const many = strokesForEdit("", "x".repeat(500));
    expect(boundedStrokes(many)).toHaveLength(MAX_STROKES_PER_EDIT);
  });
});
