/**
 * A burst is a run of consecutive agent replies with nothing from the user in between.
 * When more than one agent spoke inside a burst, chat surfaces close it with a
 * "{n} messages with {n} agents" summary, so a wall of replies reads as one exchange.
 */

export type BurstMessage = { id: string; role: string; authorId?: string | null };

export type AgentBurst = { lastMessageId: string; messages: number; authorIds: string[] };

/** Bursts in which two or more agents spoke, in thread order. */
export function multiAgentBursts(messages: BurstMessage[]): AgentBurst[] {
  const bursts: AgentBurst[] = [];
  let current: { lastMessageId: string; messages: number; authorIds: string[] } | null = null;

  const close = () => {
    if (current && current.authorIds.length > 1) {
      bursts.push({ ...current, authorIds: [...current.authorIds] });
    }
    current = null;
  };

  for (const message of messages) {
    if (message.role === "user") {
      close();
      continue;
    }
    if (message.role !== "bot") continue;
    if (!current) current = { lastMessageId: message.id, messages: 0, authorIds: [] };
    current.messages += 1;
    current.lastMessageId = message.id;
    const author = message.authorId;
    if (author && !current.authorIds.includes(author)) current.authorIds.push(author);
  }
  close();
  return bursts;
}
