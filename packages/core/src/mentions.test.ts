import { describe, expect, it } from "vitest";
import { mentionsEveryone, mentionTargets } from "./mentions.js";

const members = [
  { botId: "b1", name: "Cecil" },
  { botId: "b2", name: "Eng-Sinclair" },
  { botId: "b3", name: "PR-Donald" },
];

describe("mentionTargets", () => {
  it("wakes every member when there is no mention", () => {
    expect(mentionTargets(members, "bom dia galera")).toEqual(["b1", "b2", "b3"]);
  });

  it("wakes every member on @everyone regardless of other mentions", () => {
    expect(mentionTargets(members, "@Cecil e @everyone, status?")).toEqual(["b1", "b2", "b3"]);
    expect(mentionsEveryone("Oi @everyone")).toBe(true);
    expect(mentionsEveryone("mail@everyone.com")).toBe(false);
  });

  it("restricts the wake to mentioned members", () => {
    expect(mentionTargets(members, "@Cecil pode revisar?")).toEqual(["b1"]);
    expect(mentionTargets(members, "@Eng-Sinclair e @PR-Donald, dividam a task")).toEqual([
      "b2",
      "b3",
    ]);
  });

  it("matches names case-insensitively and with punctuation boundaries", () => {
    expect(mentionTargets(members, "valeu @cecil!")).toEqual(["b1"]);
    expect(mentionTargets(members, "email cecil@example.com")).toEqual(["b1", "b2", "b3"]);
  });

  it("honors explicit ids from the client even without a textual match", () => {
    expect(mentionTargets(members, "faz isso aí", ["b3"])).toEqual(["b3"]);
  });

  it("does not wake a shorter prefix when a longer member name is mentioned", () => {
    expect(
      mentionTargets(
        [
          { botId: "short", name: "Ada" },
          { botId: "long", name: "Ada Lovelace" },
        ],
        "@Ada Lovelace pode revisar?",
      ),
    ).toEqual(["long"]);
  });

  it("treats explicit client ids as authoritative", () => {
    expect(
      mentionTargets(
        [
          { botId: "short", name: "Ada" },
          { botId: "long", name: "Ada Lovelace" },
        ],
        "@Ada Lovelace pode revisar?",
        ["long"],
      ),
    ).toEqual(["long"]);
  });
});
