const MAX_BROWSER_URL_LENGTH = 8_192;

/**
 * Normalize a page address before handing it to the bot's graphical browser.
 * Only ordinary HTTP(S) navigation is allowed; the URL is later passed as one
 * positional argv value, never interpolated into a shell command.
 */
export function normalizeBrowserUrl(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  const hasControlCharacter = [...raw].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (!raw || raw.length > MAX_BROWSER_URL_LENGTH || hasControlCharacter) return null;

  const candidate = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password || !parsed.hostname) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function browserOpenCommand(value: unknown): ["xdg-open", string] | null {
  const url = normalizeBrowserUrl(value);
  return url ? ["xdg-open", url] : null;
}
