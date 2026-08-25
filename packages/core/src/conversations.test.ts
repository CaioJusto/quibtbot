import { describe, expect, it } from "vitest";
import { activePath, leafFrom, messageVersions, titleFromMessage } from "./conversations.js";

const messages = [
  { id: "a", parentId: null, role: "user", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "b", parentId: "a", role: "bot", createdAt: "2026-01-01T00:01:00.000Z" },
  { id: "c", parentId: "a", role: "user", createdAt: "2026-01-01T00:02:00.000Z" },
  { id: "d", parentId: "c", role: "bot", createdAt: "2026-01-01T00:03:00.000Z" },
];

describe("titleFromMessage", () => {
  it("uses the first line and caps length", () => {
    expect(titleFromMessage("  Olá time\nresto")).toBe("Olá time");
    expect(titleFromMessage("x".repeat(60)).length).toBe(48);
    expect(titleFromMessage("   ")).toBe("Nova tarefa");
  });
});

describe("activePath", () => {
  it("walks from the leaf back to the root", () => {
    expect(activePath(messages, "d").map((row) => row.id)).toEqual(["a", "c", "d"]);
    expect(activePath(messages, "b").map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("falls back to the full list when the leaf is missing", () => {
    expect(activePath(messages, "missing")).toEqual(messages);
    expect(activePath(messages, null)).toEqual(messages);
  });
});

describe("messageVersions and leafFrom", () => {
  it("groups siblings that share a parent and role", () => {
    const forked = [
      ...messages,
      { id: "c2", parentId: "a", role: "user", createdAt: "2026-01-01T00:04:00.000Z" },
    ];
    expect(messageVersions(forked, forked[2]!).map((row) => row.id)).toEqual(["c", "c2"]);
  });

  it("descends to the newest child when switching a mid-branch", () => {
    expect(leafFrom(messages, "a")).toBe("d");
    expect(leafFrom(messages, "c")).toBe("d");
    expect(leafFrom(messages, "d")).toBe("d");
  });
});
