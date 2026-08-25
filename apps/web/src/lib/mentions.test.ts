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
  { id: "bot_ana", name: "Ana" },
  { id: "bot_ana_lucia", name: "Ana Lucia" },
  { id: "bot_chief", name: "Chief" },
];

describe("activeMention", () => {
  it("finds the token the caret sits in", () => {
    expect(activeMention("ping @ad", 8)).toEqual({ query: "ad", start: 5 });
    expect(activeMention("@", 1)).toEqual({ query: "", start: 0 });
  });

  it("ignores text with no open mention", () => {
    expect(activeMention("no mention here", 15)).toBeNull();
    expect(activeMention("ping @Ada now", 13)).toBeNull();
  });

  it("does not treat an email address as a mention", () => {
    expect(activeMention("mail ada@quibt", 15)).toBeNull();
  });

  it("only looks at text before the caret", () => {
    expect(activeMention("@Ada and @Chief", 4)).toEqual({ query: "Ada", start: 0 });
  });
});

describe("activeSlash", () => {
  it("finds the skill token the caret sits in", () => {
    expect(activeSlash("run /week", 9)).toEqual({ query: "week", start: 4 });
    expect(activeSlash("/", 1)).toEqual({ query: "", start: 0 });
    expect(activeSlash("no slash here", 13)).toBeNull();
  });
});

describe("activeComposerToken", () => {
  it("prefers @ over / when both could match", () => {
    expect(activeComposerToken("hi @ad", 6)?.kind).toBe("mention");
    expect(activeComposerToken("hi /he", 6)?.kind).toBe("skill");
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

describe("insertMention", () => {
  it("completes the token and keeps the rest of the draft", () => {
    expect(insertMention("ping @ad about the deck", 8, "Ada")).toEqual({
      text: "ping @Ada about the deck",
      caret: 10,
    });
  });

  it("inserts at the caret when no token is open", () => {
    expect(insertMention("ping ", 5, "Ada")).toEqual({ text: "ping @Ada ", caret: 10 });
  });
});

describe("matchesMention", () => {
  it("matches every name on an empty query", () => {
    expect(matchesMention("Ada", "")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(matchesMention("Ada", "AD")).toBe(true);
    expect(matchesMention("Ada", "chief")).toBe(false);
  });
});

describe("mentionedTargets", () => {
  it("finds mentioned bots and leaves the text alone", () => {
    const text = "@Ada please sync with @Chief";
    expect(mentionedTargets(text, peers).map((p) => p.id)).toEqual(["bot_ada", "bot_chief"]);
    expect(text).toBe("@Ada please sync with @Chief");
  });

  it("ignores unmentioned bots and bare names", () => {
    expect(mentionedTargets("Ada should look at this", peers)).toEqual([]);
  });

  it("does not match a name that is only a prefix of the typed mention", () => {
    expect(mentionedTargets("@Adam ship it", peers)).toEqual([]);
  });

  it("prefers the longest matching name", () => {
    expect(mentionedTargets("@Ana Lucia can you help", peers).map((p) => p.id)).toEqual([
      "bot_ana_lucia",
    ]);
  });

  it("does not treat an email address as a mention", () => {
    expect(mentionedTargets("write to ada@Chief.com", peers)).toEqual([]);
  });

  it("returns each bot once", () => {
    expect(mentionedTargets("@Ada @Ada", peers).map((p) => p.id)).toEqual(["bot_ada"]);
  });

  it("does not treat @everyone as a bot name — the server wakes the whole group from the text", () => {
    expect(mentionedTargets("@everyone status?", peers)).toEqual([]);
  });
});

describe("matchesMention with accents and spaces", () => {
  it("matches a name typed without accents", () => {
    // The whole product speaks Portuguese: "Cecília" has to answer to "cecilia".
    expect(matchesMention("Cecília", "cecilia")).toBe(true);
    expect(matchesMention("Cecilia", "cecília")).toBe(true);
    expect(matchesMention("Ação semanal", "acao")).toBe(true);
  });

  it("still refuses a name that does not match", () => {
    expect(matchesMention("Cecília", "ada")).toBe(false);
  });

  it("treats a blank query as no filter", () => {
    expect(matchesMention("Ada", " ")).toBe(true);
  });
});

describe("activeSlash boundaries", () => {
  it("ignores a slash inside a word or a URL", () => {
    expect(activeSlash("prós e/ou contras", 17)).toBeNull();
    expect(activeSlash("veja https://quibt.app/skills", 29)).toBeNull();
    expect(activeSlash("abra /etc/hosts", 15)).toBeNull();
  });

  it("finds the skill token with an accent in it", () => {
    expect(activeSlash("/relatório", 10)).toEqual({ query: "relatório", start: 0 });
  });
});
