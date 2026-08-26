import { describe, expect, it } from "vitest";
import { messageText, stepMatch, threadMatches } from "./thread-search";

const thread = [
  { id: "m1", blocks: [{ kind: "text", text: "Marquei a reunião de terça" }] },
  { id: "m2", blocks: [{ kind: "card", lines: [{ k: "a", v: "b" }] }] },
  { id: "m3", blocks: [{ kind: "meta", text: "abriu o computador" }] },
  { id: "m4", blocks: [{ kind: "text", text: "A REUNIAO mudou de sala" }] },
];

describe("achar na conversa", () => {
  it("junta o texto dos blocos e ignora os que não têm nenhum", () => {
    expect(messageText(thread[0]!)).toBe("Marquei a reunião de terça");
    expect(messageText(thread[1]!)).toBe("");
    expect(messageText({ id: "m5" })).toBe("");
  });

  it("acha sem acento e sem ligar para maiúscula, como o ⌘K", () => {
    expect(threadMatches(thread, "reuniao")).toEqual(["m1", "m4"]);
    expect(threadMatches(thread, "REUNIÃO")).toEqual(["m1", "m4"]);
  });

  it("devolve as ocorrências na ordem do fio", () => {
    expect(threadMatches(thread, "a")).toEqual(["m1", "m3", "m4"]);
  });

  it("busca vazia não marca a conversa inteira", () => {
    expect(threadMatches(thread, "")).toEqual([]);
    expect(threadMatches(thread, "   ")).toEqual([]);
    expect(threadMatches(thread, "nada disso")).toEqual([]);
  });

  it("n/N dá a volta nos dois sentidos", () => {
    expect(stepMatch(0, 3, 1)).toBe(1);
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
    expect(stepMatch(0, 0, 1)).toBe(0);
  });
});
