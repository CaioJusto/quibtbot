import { describe, expect, it } from "vitest";
import { capHistory } from "./history.js";

describe("history cap", () => {
  it("returns the list unchanged when under the cap", () => {
    const history = [
      { role: "user" as const, content: "a" },
      { role: "assistant" as const, content: "b" },
    ];
    expect(capHistory(history, 40)).toEqual(history);
  });

  it("keeps the newest messages", () => {
    const history = Array.from({ length: 5 }, (_, i) => ({
      role: "user" as const,
      content: String(i),
    }));
    expect(capHistory(history, 2).map((m) => m.content)).toEqual(["3", "4"]);
  });

  it("caps a long thread to the newest 40 messages by default", () => {
    const history = Array.from({ length: 50 }, (_, i) => ({
      role: "user" as const,
      content: String(i),
    }));
    expect(capHistory(history)).toHaveLength(40);
    expect(capHistory(history)[0]?.content).toBe("10");
    expect(capHistory(history).at(-1)?.content).toBe("49");
  });

  it("preserves a leading system message when truncating", () => {
    const history = [
      { role: "system" as const, content: "rules" },
      ...Array.from({ length: 4 }, (_, i) => ({
        role: "user" as const,
        content: String(i),
      })),
    ];
    expect(capHistory(history, 3).map((m) => m.content)).toEqual(["rules", "2", "3"]);
  });
});
