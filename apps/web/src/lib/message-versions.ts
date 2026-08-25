type VersionRow = { id: string; parentId?: string | null; role: string };

/** Sibling versions share a role and a parent — that is what an edit branch looks like. */
export function versionKey(message: VersionRow) {
  return `${message.role}\u0000${message.parentId ?? ""}`;
}

/**
 * Groups a thread into edit branches in one pass. Rendering used to call `messageVersions`
 * (an O(n) scan) twice per message, which is O(n²) on every streaming tick.
 */
export function versionsByParent<T extends VersionRow>(messages: readonly T[]): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const message of messages) {
    const key = versionKey(message);
    const siblings = index.get(key);
    if (siblings) siblings.push(message);
    else index.set(key, [message]);
  }
  return index;
}

export function versionsOf<T extends VersionRow>(index: Map<string, T[]>, message: T): T[] {
  return index.get(versionKey(message)) ?? [];
}
