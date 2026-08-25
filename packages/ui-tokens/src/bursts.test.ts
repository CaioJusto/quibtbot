import { describe, expect, it } from "vitest";
import { type BurstMessage, multiAgentBursts } from "./bursts.js";

function thread(...messages: Array<[string, string, string?]>): BurstMessage[] {
  return messages.map(([id, role, authorId]) => ({ id, role, authorId }));
}

describe("multiAgentBursts", () => {
  it("summarises a run of replies once more than one agent spoke", () => {
    const bursts = multiAgentBursts(
      thread(["m1", "user"], ["m2", "bot", "chief"], ["m3", "bot", "ada"], ["m4", "bot", "chief"]),
    );

    expect(bursts).toEqual([{ lastMessageId: "m4", messages: 3, authorIds: ["chief", "ada"] }]);
  });

  it("ignores a burst a single agent wrote alone", () => {
    expect(
      multiAgentBursts(thread(["m1", "user"], ["m2", "bot", "chief"], ["m3", "bot", "chief"])),
    ).toEqual([]);
  });

  it("splits bursts on the user's replies", () => {
    const bursts = multiAgentBursts(
      thread(
        ["m1", "bot", "chief"],
        ["m2", "bot", "ada"],
        ["m3", "user"],
        ["m4", "bot", "ada"],
        ["m5", "bot", "rex"],
        ["m6", "bot", "chief"],
      ),
    );

    expect(bursts.map((burst) => burst.lastMessageId)).toEqual(["m2", "m6"]);
    expect(bursts[1]).toEqual({
      lastMessageId: "m6",
      messages: 3,
      authorIds: ["ada", "rex", "chief"],
    });
  });

  it("skips system rows and unattributed replies without breaking a burst", () => {
    const bursts = multiAgentBursts(
      thread(["m1", "bot", "chief"], ["m2", "system"], ["m3", "bot"], ["m4", "bot", "ada"]),
    );

    expect(bursts).toEqual([{ lastMessageId: "m4", messages: 3, authorIds: ["chief", "ada"] }]);
  });
});
