import { describe, expect, it } from "vitest";
import { isAnsweringMessage, isTurnStartMarker } from "./turn-start";

describe("turn start marker", () => {
  it("recognises the runtime's opening progress in both languages", () => {
    expect(isTurnStartMarker("Trabalhando…")).toBe(true);
    expect(isTurnStartMarker(" working... ")).toBe(true);
    expect(isTurnStartMarker("Abrindo o navegador…")).toBe(false);
  });

  it("does not count the opening marker as the bot answering", () => {
    expect(
      isAnsweringMessage({ role: "bot", blocks: [{ kind: "progress", text: "Trabalhando…" }] }),
    ).toBe(false);
    expect(
      isAnsweringMessage({ role: "bot", blocks: [{ kind: "progress", text: "Olá, vou" }] }),
    ).toBe(true);
    expect(isAnsweringMessage({ role: "bot", blocks: [{ kind: "text", text: "Oi" }] })).toBe(true);
    expect(isAnsweringMessage({ role: "user", blocks: [{ kind: "text", text: "Oi" }] })).toBe(
      false,
    );
  });
});
