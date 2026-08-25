export type MentionTarget = { id: string; name: string };
export type ComposerToken = { query: string; start: number; kind: "mention" | "skill" };

const TRAILING_MENTION = /(?:^|[\s(])@([^\s@]*)$/u;
const TRAILING_SLASH = /(?:^|[\s(])\/([^\s/]*)$/u;

/** The `@…` token the caret is currently sitting in, if any. */
export function activeMention(
  text: string,
  caret: number,
): { query: string; start: number } | null {
  return activeToken(text, caret, TRAILING_MENTION);
}

/** The `/…` skill token the caret is currently sitting in, if any. */
export function activeSlash(text: string, caret: number): { query: string; start: number } | null {
  return activeToken(text, caret, TRAILING_SLASH);
}

export function activeComposerToken(text: string, caret: number): ComposerToken | null {
  const mention = activeMention(text, caret);
  if (mention) return { ...mention, kind: "mention" };
  const slash = activeSlash(text, caret);
  if (slash) return { ...slash, kind: "skill" };
  return null;
}

function activeToken(
  text: string,
  caret: number,
  pattern: RegExp,
): { query: string; start: number } | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const match = pattern.exec(before);
  if (!match) return null;
  const query = match[1] ?? "";
  return { query, start: before.length - query.length - 1 };
}

/** Lowercase and drop accents: "Cecília" has to answer to "cecilia" while you type. */
function fold(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

export function matchesMention(name: string, query: string) {
  if (!query.trim()) return true;
  return fold(name).includes(fold(query));
}

/** Replace the token under the caret with `@Name `, leaving the rest of the draft alone. */
export function insertMention(
  text: string,
  caret: number,
  name: string,
): { text: string; caret: number } {
  return insertComposerToken(text, caret, `@${name}`, activeMention(text, caret));
}

/** Replace the token under the caret with `/Name `, leaving the rest of the draft alone. */
export function insertSlash(
  text: string,
  caret: number,
  name: string,
): { text: string; caret: number } {
  return insertComposerToken(text, caret, `/${name}`, activeSlash(text, caret));
}

function insertComposerToken(
  text: string,
  caret: number,
  tokenValue: string,
  active: { start: number } | null,
): { text: string; caret: number } {
  const position = Math.max(0, Math.min(caret, text.length));
  const start = active ? active.start : position;
  const rest = text.slice(position);
  const spaced = rest.startsWith(" ");
  const token = spaced ? tokenValue : `${tokenValue} `;
  return {
    text: `${text.slice(0, start)}${token}${rest}`,
    caret: start + token.length + (spaced ? 1 : 0),
  };
}

/** Targets named with `@Name` in the text. The text itself is never rewritten. */
export function mentionedTargets<T extends MentionTarget>(text: string, targets: T[]): T[] {
  const matched = targets.filter((target) => target.name.trim() && mentions(text, target.name));
  return matched.filter(
    (target) =>
      !matched.some(
        (other) =>
          other !== target &&
          other.name.length > target.name.length &&
          other.name.toLowerCase().startsWith(target.name.toLowerCase()),
      ),
  );
}

function mentions(text: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_@])@${escaped}(?![\\p{L}\\p{N}_-])`, "iu").test(text);
}
