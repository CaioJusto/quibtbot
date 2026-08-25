import { describe, expect, it } from "vitest";
import { groupAuthor, latestPeerPing, peerAuthor } from "./thread-authors.js";

const bots = [
  { id: "bot_ada", name: "Ada", color: "#E65707" },
  { id: "bot_chief", name: "Chief", color: "#30A24B" },
];

describe("peerAuthor", () => {
  it("labels a message written by another bot", () => {
    expect(peerAuthor({ fromBotId: "bot_ada" }, "bot_chief", bots)).toEqual({
      id: "bot_ada",
      name: "Ada",
      color: "#E65707",
    });
  });

  it("leaves the user's own messages unlabelled", () => {
    expect(peerAuthor({ fromBotId: undefined }, "bot_chief", bots)).toBeNull();
  });

  it("does not label the thread's own bot", () => {
    expect(peerAuthor({ fromBotId: "bot_chief" }, "bot_chief", bots)).toBeNull();
  });

  it("still renders a sender that is no longer in the bot list", () => {
    expect(peerAuthor({ fromBotId: "bot_gone" }, "bot_chief", bots)?.name).toBe("Another bot");
  });
});

describe("groupAuthor", () => {
  it("uses authorBotId to attribute a group message", () => {
    expect(groupAuthor({ authorBotId: "bot_chief" }, bots)?.name).toBe("Chief");
  });

  it("falls back to fromBotId", () => {
    expect(groupAuthor({ fromBotId: "bot_ada" }, bots)?.name).toBe("Ada");
  });

  it("carries the member's mark shape into a group reply", () => {
    expect(
      groupAuthor({ authorBotId: "bot_sinclair" }, [
        { id: "bot_sinclair", name: "Sinclair", color: "#8E8E93", shape: "triangle" },
      ]),
    ).toEqual({
      id: "bot_sinclair",
      name: "Sinclair",
      color: "#8E8E93",
      shape: "triangle",
    });
  });
});

describe("latestPeerPing", () => {
  it("names the bot behind the newest peer message", () => {
    expect(
      latestPeerPing(
        [
          { role: "user" },
          { role: "bot", fromBotId: "bot_ada" },
          { role: "bot", fromBotId: undefined },
        ],
        "bot_chief",
        bots,
      )?.name,
    ).toBe("Ada");
  });

  it("clears once the user replies", () => {
    expect(
      latestPeerPing([{ role: "bot", fromBotId: "bot_ada" }, { role: "user" }], "bot_chief", bots),
    ).toBeNull();
  });

  it("stays empty in a thread only this bot has spoken in", () => {
    expect(latestPeerPing([{ role: "bot", fromBotId: "bot_chief" }], "bot_chief", bots)).toBeNull();
  });
});
