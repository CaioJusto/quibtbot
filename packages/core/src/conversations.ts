export const UNTITLED_TASK = "Nova tarefa";

export function titleFromMessage(text: string): string {
  const line = text.trim().split(/\n/)[0]?.trim() ?? "";
  if (!line) return UNTITLED_TASK;
  return line.length > 48 ? `${line.slice(0, 47)}…` : line;
}

export function activePath<T extends { id: string; parentId?: string | null }>(
  messages: T[],
  activeLeafId: string | null | undefined,
): T[] {
  if (!messages.length) return [];
  if (!activeLeafId) return messages;
  const byId = new Map(messages.map((message) => [message.id, message]));
  if (!byId.has(activeLeafId)) return messages;
  const path: T[] = [];
  const seen = new Set<string>();
  let current: T | undefined = byId.get(activeLeafId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.reverse();
}

export function messageVersions<T extends { id: string; parentId?: string | null; role: string }>(
  messages: T[],
  message: T,
): T[] {
  const parent = message.parentId ?? null;
  return messages.filter((row) => row.role === message.role && (row.parentId ?? null) === parent);
}

export function newestChild<T extends { id: string; parentId?: string | null; createdAt?: string }>(
  messages: T[],
  parentId: string,
): T | undefined {
  const children = messages.filter((row) => row.parentId === parentId);
  if (!children.length) return undefined;
  return children.reduce((latest, row) => {
    if (!latest.createdAt || !row.createdAt) return row;
    return row.createdAt > latest.createdAt ? row : latest;
  });
}

/** Walk down to the newest leaf under a message so switching a mid-branch shows the full fork. */
export function leafFrom<T extends { id: string; parentId?: string | null; createdAt?: string }>(
  messages: T[],
  messageId: string,
): string {
  let current = messageId;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const child = newestChild(messages, current);
    if (!child) return current;
    current = child.id;
  }
  return current;
}
