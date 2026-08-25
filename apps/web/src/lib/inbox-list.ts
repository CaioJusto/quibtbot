/** Pure list rules for the inbox: what shows, what is hidden, and what the toggle may claim. */

export type InboxBot = {
  id: string;
  name: string;
  title: string;
  preview: string;
  hidden?: boolean;
};

export function matchesInboxQuery(haystack: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || haystack.toLowerCase().includes(q);
}

/**
 * Hidden bots that the current search would actually reveal. Counting every hidden bot would
 * promise rows the filter is never going to show.
 */
export function hiddenBotCount<T extends InboxBot>(bots: T[], query: string): number {
  return bots.filter(
    (bot) => bot.hidden && matchesInboxQuery(`${bot.name} ${bot.title} ${bot.preview}`, query),
  ).length;
}

/**
 * With no hidden bot left to reveal, "showing hidden" is not a state the user can see or leave —
 * so it must not survive and quietly un-hide the next bot they hide.
 */
export function revealsHidden(showHidden: boolean, hiddenCount: number): boolean {
  return showHidden && hiddenCount > 0;
}

export function visibleInboxBots<T extends InboxBot>(bots: T[], showHidden: boolean): T[] {
  return bots.filter((bot) => showHidden || !bot.hidden);
}

export function hiddenToggleLabel(showHidden: boolean, hiddenCount: number): string {
  if (showHidden) return "Ocultar bots escondidos";
  const plural = hiddenCount === 1 ? "" : "s";
  return `Mostrar ${hiddenCount} bot${plural} oculto${plural}`;
}
