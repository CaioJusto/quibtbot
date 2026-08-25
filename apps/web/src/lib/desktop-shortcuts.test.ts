import { describe, expect, it } from "vitest";
import { shortcutFromKey, starterPrompts, visibleShortcutTargets } from "./desktop-shortcuts";

describe("desktop shortcuts", () => {
  const bots = [
    { id: "b1", hidden: false, pinned: false },
    { id: "b2", hidden: true, pinned: true },
    { id: "b3", hidden: false, pinned: true },
  ];
  const groups = [{ id: "g1" }];

  it("lists groups first, then pinned bots, and skips hidden ones", () => {
    expect(visibleShortcutTargets(bots, groups)).toEqual([
      { kind: "group", id: "g1" },
      { kind: "bot", id: "b3" },
      { kind: "bot", id: "b1" },
    ]);
  });

  it("maps ⌘N and number keys", () => {
    const targets = visibleShortcutTargets(bots, groups);
    expect(
      shortcutFromKey({ key: "n", metaKey: true, ctrlKey: false, shiftKey: false }, targets),
    ).toEqual({
      action: "new-bot",
    });
    expect(
      shortcutFromKey({ key: "1", metaKey: true, ctrlKey: false, shiftKey: false }, targets),
    ).toEqual({
      action: "select",
      target: { kind: "group", id: "g1" },
    });
    expect(
      shortcutFromKey({ key: "2", ctrlKey: true, metaKey: false, shiftKey: false }, targets),
    ).toEqual({
      action: "select",
      target: { kind: "bot", id: "b3" },
    });
  });

  it("cycles with ⌘⇧[ and ⌘⇧]", () => {
    const targets = visibleShortcutTargets(bots, groups);
    expect(
      shortcutFromKey({ key: "]", metaKey: true, ctrlKey: false, shiftKey: true }, targets, "g1"),
    ).toEqual({ action: "cycle", target: { kind: "bot", id: "b3" } });
    expect(
      shortcutFromKey({ key: "[", metaKey: true, ctrlKey: false, shiftKey: true }, targets, "b1"),
    ).toEqual({ action: "cycle", target: { kind: "bot", id: "b3" } });
  });

  it("keeps starter prompts personal", () => {
    expect(starterPrompts("Ada")[0]).toContain("Ada");
  });
});
