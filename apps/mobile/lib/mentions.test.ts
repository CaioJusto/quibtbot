import { describe, expect, it } from "vitest";
import {
  activeComposerToken,
  activeMention,
  activeSlash,
  insertMention,
  insertSlash,
  matchesMention,
  mentionedTargets,
} from "./mentions.js";

const peers = [
  { id: "bot_ada", name: "Ada" },
  { id: "bot_adalovelace", name: "Ada Lovelace" },
  { id: "bot_rex", name: "Rex" },
];

describe("activeMention", () => {
  it("finds the token being typed", () => {
    expect(activeMention("ping @ad")).toEqual({ query: "ad", start: 5 });
    expect(activeMention("@")).toEqual({ query: "", start: 0 });
    expect(activeMention("ping @ad", 8)).toEqual({ query: "ad", start: 5 });
  });

  it("ignores finished words and e-mail-ish text", () => {
    expect(activeMention("ping @Ada now")).toBeNull();
    expect(activeMention("write to ada@example.com")).toBeNull();
  });
});

describe("activeSlash", () => {
  it("finds the skill token being typed", () => {
    expect(activeSlash("run /week", 9)).toEqual({ query: "week", start: 4 });
    expect(activeSlash("/")).toEqual({ query: "", start: 0 });
    expect(activeSlash("no slash here", 13)).toBeNull();
  });

  it("ignores a slash inside a word or a URL", () => {
    expect(activeSlash("https://example.com/foo", 23)).toBeNull();
  });
});

describe("activeComposerToken", () => {
  it("prefers @ over / when both could match", () => {
    expect(activeComposerToken("hi @ad", 6)?.kind).toBe("mention");
    expect(activeComposerToken("hi /he", 6)?.kind).toBe("skill");
  });
});

describe("insertMention", () => {
  it("completes the token in place", () => {
    expect(insertMention("ping @ad", "Ada")).toBe("ping @Ada ");
    expect(insertMention("ping ", "Rex")).toBe("ping @Rex ");
    expect(insertMention("ping @ad about the deck", 8, "Ada")).toEqual({
      text: "ping @Ada about the deck",
      caret: 10,
    });
  });
});

describe("insertSlash", () => {
  it("completes the skill token", () => {
    expect(insertSlash("run /week", 9, "Weekly health")).toEqual({
      text: "run /Weekly health ",
      caret: 19,
    });
  });
});

describe("mentionedTargets", () => {
  it("returns only the bots actually named", () => {
    expect(mentionedTargets("ping @Rex about the deck", peers).map((p) => p.id)).toEqual([
      "bot_rex",
    ]);
  });

  it("prefers the longest matching name", () => {
    expect(mentionedTargets("@Ada Lovelace can you look?", peers).map((p) => p.id)).toEqual([
      "bot_adalovelace",
    ]);
  });

  it("ignores a name that is only part of another word", () => {
    expect(mentionedTargets("no mentions here", peers)).toEqual([]);
  });
});

describe("matchesMention", () => {
  it("matches on any part of the name, case-insensitively", () => {
    expect(matchesMention("Ada Lovelace", "love")).toBe(true);
    expect(matchesMention("Rex", "ad")).toBe(false);
    expect(matchesMention("Rex", "")).toBe(true);
  });
});

describe("matchesMention with accents", () => {
  it("matches a Portuguese name typed without accents", () => {
    expect(matchesMention("Cecília", "cecilia")).toBe(true);
    expect(matchesMention("Ação semanal", "acao")).toBe(true);
    expect(matchesMention("Cecília", "ada")).toBe(false);
  });

  it("treats a blank query as no filter", () => {
    expect(matchesMention("Ada", " ")).toBe(true);
  });
});
