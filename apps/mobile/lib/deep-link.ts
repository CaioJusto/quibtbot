export type AppDeepLink = {
  path: string;
  searchParams: URLSearchParams;
};

/**
 * Reads `quibt://plugins/callback` the same way as Expo Go's
 * `exp://192.168.1.5:8081/--/plugins/callback`. Host-style schemes put the first
 * segment in `hostname`; Expo Go hides the route after `/--/`.
 */
export function parseAppDeepLink(raw: string): AppDeepLink | null {
  try {
    const parsed = new URL(raw);
    const expo = parsed.pathname.match(/\/--\/([^?]*)/);
    const fromExpo = (expo?.[1] ?? "").replace(/^\/+|\/+$/g, "");
    const host = parsed.hostname || "";
    const pathPart = parsed.pathname.replace(/^\/+|\/+$/g, "");
    const fromScheme = [host, pathPart].filter(Boolean).join("/");
    const path = (fromExpo || fromScheme).replace(/\/+$/, "");
    if (!path) return null;
    return { path, searchParams: parsed.searchParams };
  } catch {
    return null;
  }
}

export function deepLinkIs(path: string, ...aliases: string[]) {
  return aliases.some((alias) => path === alias || path.endsWith(`/${alias}`));
}
