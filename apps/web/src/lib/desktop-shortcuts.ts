export type ShortcutTarget = { kind: "bot" | "group"; id: string };

export function visibleShortcutTargets<
  T extends { id: string; hidden?: boolean; pinned?: boolean },
>(bots: T[], groups: Array<{ id: string }>): ShortcutTarget[] {
  const visible = bots
    .filter((bot) => !bot.hidden)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned));
  return [
    ...groups.map((group) => ({ kind: "group" as const, id: group.id })),
    ...visible.map((bot) => ({ kind: "bot" as const, id: bot.id })),
  ];
}

export function shortcutFromKey(
  event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
  targets: ShortcutTarget[],
  selectedId?: string,
):
  | { action: "new-bot" }
  | { action: "select"; target: ShortcutTarget }
  | { action: "cycle"; target: ShortcutTarget }
  | null {
  const mod = event.metaKey || event.ctrlKey;
  if (!mod) return null;
  if (event.key === "n" && !event.shiftKey) return { action: "new-bot" };
  if (/^[1-9]$/.test(event.key)) {
    const target = targets[Number(event.key) - 1];
    return target ? { action: "select", target } : null;
  }
  if (event.shiftKey && (event.key === "[" || event.key === "]")) {
    if (!targets.length) return null;
    const idx = Math.max(
      0,
      targets.findIndex((target) => target.id === selectedId),
    );
    const next = targets[(idx + (event.key === "]" ? 1 : -1) + targets.length) % targets.length];
    return next ? { action: "cycle", target: next } : null;
  }
  return null;
}

/**
 * ⌘F no Mac, Ctrl+F no resto: achar dentro da conversa aberta.
 *
 * Vale mesmo com o cursor dentro do campo de escrever — é ali que a mão está quando dá
 * vontade de reler o que o bot respondeu há vinte recados. O navegador também usa ⌘F, mas
 * o dele procura só no que está desenhado: numa conversa que rola, isso acha quase nada.
 */
export function opensThreadSearch(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f";
}

export function starterPrompts(name: string): string[] {
  return [
    `O que você consegue fazer por mim, ${name}?`,
    "Olha o que chegou hoje e me resume.",
    "Monta um plano curto pro próximo passo.",
  ];
}
