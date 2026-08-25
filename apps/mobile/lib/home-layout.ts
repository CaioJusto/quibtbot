export const MAX_FAVORITE_BOTS = 3;

export type HomeListItem<B, G> =
  | { kind: "bot"; key: `bot:${string}`; bot: B }
  | { kind: "group"; key: `group:${string}`; group: G };

export function homeListItems<B extends { id: string }, G extends { id: string }>(
  bots: readonly B[],
  groups: readonly G[],
): HomeListItem<B, G>[] {
  return [
    ...bots.map((bot) => ({ kind: "bot" as const, key: `bot:${bot.id}` as const, bot })),
    ...groups.map((group) => ({
      kind: "group" as const,
      key: `group:${group.id}` as const,
      group,
    })),
  ];
}

export function splitHomeBots<T extends { pinned?: boolean }>(
  bots: T[],
  searchOpen: boolean,
): { favorites: T[]; list: T[] } {
  if (searchOpen) return { favorites: [], list: bots };

  const favorites = bots.filter((bot) => bot.pinned).slice(0, MAX_FAVORITE_BOTS);
  const favoriteSet = new Set(favorites);

  return {
    favorites,
    list: bots.filter((bot) => !favoriteSet.has(bot)),
  };
}

/**
 * A hidden bot never shows up in the favourites row, so it must not eat one of the three slots
 * either — otherwise hiding pinned bots quietly locks the user out of pinning anything.
 */
export function canPinFavorite<T extends { pinned?: boolean; hidden?: boolean }>(
  bots: T[],
  bot: T,
): boolean {
  return (
    Boolean(bot.pinned) ||
    bots.filter((candidate) => candidate.pinned && !candidate.hidden).length < MAX_FAVORITE_BOTS
  );
}
