const WEEKDAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

function dayKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

const DAY_MS = 86_400_000;

/**
 * Inbox row time: "14:45" today, "Yesterday" yesterday,
 * otherwise a short date.
 */
export function inboxTimeLabel(iso: string, now: Date = new Date()): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (diffDays <= 0) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  if (diffDays === 1) return "Ontem";
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

/**
 * Grok-style chip label: relative day + 24h time.
 * "Today 14:45", "Yesterday 10:35", otherwise "Mon 12 09:15".
 */
export function dayStampLabel(iso: string, now: Date = new Date()): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (diffDays <= 0) return `Hoje ${time}`;
  if (diffDays === 1) return `Ontem ${time}`;
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${time}`;
}

/**
 * Where date chips go in a message list: before the first message, and whenever
 * the calendar day changes between consecutive messages. Returns labels keyed
 * by the id of the message the chip precedes.
 */
export function dayStamps(
  messages: Array<{ id: string; createdAt?: string }>,
  now: Date = new Date(),
): Record<string, string> {
  const stamps: Record<string, string> = {};
  let previousDay: string | null = null;
  for (const message of messages) {
    if (!message.createdAt) continue;
    const date = new Date(message.createdAt);
    if (Number.isNaN(date.getTime())) continue;
    const day = dayKey(date);
    if (day !== previousDay) {
      const label = dayStampLabel(message.createdAt, now);
      if (label) stamps[message.id] = label;
    }
    previousDay = day;
  }
  return stamps;
}
