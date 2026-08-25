const EVERYONE_MENTION = /(^|[^\p{L}\p{N}_@])@everyone(?![\p{L}\p{N}_-])/iu;

export function mentionsEveryone(text: string): boolean {
  return EVERYONE_MENTION.test(text);
}

/**
 * Resolves which group members a message is addressed to. Mentioning specific
 * members restricts the wake to them; "@everyone" or a message with no
 * mentions wakes the whole group.
 */
export function mentionTargets(
  members: Array<{ botId: string; name: string }>,
  text: string,
  explicitBotIds: string[] = [],
): string[] {
  if (mentionsEveryone(text)) return members.map((member) => member.botId);
  if (explicitBotIds.length) {
    const explicit = new Set(explicitBotIds);
    return members.filter((member) => explicit.has(member.botId)).map((member) => member.botId);
  }
  const mentioned = members.filter((member) => {
    const escaped = member.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}\\p{N}_@])@${escaped}(?![\\p{L}\\p{N}_-])`, "iu").test(text);
  });
  const unambiguous = mentioned.filter(
    (member) =>
      !mentioned.some(
        (other) =>
          other !== member &&
          other.name.length > member.name.length &&
          other.name.toLocaleLowerCase().startsWith(member.name.toLocaleLowerCase()),
      ),
  );
  return unambiguous.length
    ? unambiguous.map((member) => member.botId)
    : members.map((member) => member.botId);
}
