export const HISTORY_MESSAGE_CAP = 40;

export type HistoryMessage = { role: "user" | "assistant" | "system"; content: string };

/** Keep the newest messages. If the first item is system, keep it plus the tail. */
export function capHistory(history: HistoryMessage[], cap = HISTORY_MESSAGE_CAP): HistoryMessage[] {
  if (cap < 1 || history.length <= cap) return history;
  const head = history[0];
  if (head?.role === "system") {
    const keep = Math.max(1, cap - 1);
    return [head, ...history.slice(-keep)];
  }
  return history.slice(-cap);
}
