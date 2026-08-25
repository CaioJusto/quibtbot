import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canPinFavorite, homeListItems, MAX_FAVORITE_BOTS, splitHomeBots } from "./home-layout";

const dir = path.dirname(fileURLToPath(import.meta.url));
const bots = [
  { id: "one", pinned: true },
  { id: "two", pinned: true },
  { id: "three", pinned: true },
  { id: "four", pinned: true },
  { id: "regular" },
];

describe("home favorites", () => {
  it("shows at most three pinned bots above without hiding legacy overflow", () => {
    const home = splitHomeBots(bots, false);
    expect(home.favorites.map((bot) => bot.id)).toEqual(["one", "two", "three"]);
    expect(home.list.map((bot) => bot.id)).toEqual(["four", "regular"]);
    expect(home.favorites).toHaveLength(MAX_FAVORITE_BOTS);
  });

  it("uses the full matching list while search is open", () => {
    const home = splitHomeBots(bots, true);
    expect(home.favorites).toEqual([]);
    expect(home.list).toEqual(bots);
  });

  it("allows unpinning at the limit but blocks a fourth favorite", () => {
    expect(canPinFavorite(bots.slice(0, 3), bots[0]!)).toBe(true);
    expect(canPinFavorite(bots.slice(0, 3), { id: "new" })).toBe(false);
  });
});

describe("hidden bots and the favorite limit", () => {
  const hiddenPins: Array<{ id: string; pinned?: boolean; hidden?: boolean }> = [
    { id: "one", pinned: true, hidden: true },
    { id: "two", pinned: true, hidden: true },
    { id: "three", pinned: true, hidden: true },
  ];

  it("does not let hidden pinned bots eat the three visible slots", () => {
    // None of them shows in the favourites row, so "Máximo de 3 favoritos" would be a lie.
    expect(canPinFavorite(hiddenPins, { id: "new" })).toBe(true);
  });

  it("still blocks a fourth visible favorite", () => {
    const visiblePins: typeof hiddenPins = hiddenPins.map((bot) => ({ ...bot, hidden: false }));
    expect(canPinFavorite(visiblePins, { id: "new" })).toBe(false);
  });
});

describe("virtualized home rows", () => {
  it("builds stable typed rows for bots and groups", () => {
    const rows = homeListItems([{ id: "one" }, { id: "two" }], [{ id: "team" }]);
    expect(rows.map((row) => row.key)).toEqual(["bot:one", "bot:two", "group:team"]);
    expect(rows.map((row) => row.kind)).toEqual(["bot", "bot", "group"]);
  });

  it("renders the inbox through FlatList", () => {
    const screen = readFileSync(path.join(dir, "../app/index.tsx"), "utf8");
    expect(screen).toContain("<FlatList");
    expect(screen).not.toContain("<ScrollView");
  });
});
