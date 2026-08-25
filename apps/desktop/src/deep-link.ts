export function webUrlFromDeepLink(raw: string, webOrigin: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "quibt:") return null;
    const origin = webOrigin.replace(/\/$/, "");
    // `quibt://thread/abc` parses as host "thread" plus path "/abc": both belong to the route.
    const segments = `${url.hostname}/${url.pathname}`
      .split("/")
      .filter((segment) => segment && segment !== "." && segment !== "..");
    const target = segments.join("/");
    if (!target) return origin;
    return `${origin}/${target}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export function firstDeepLinkFromArgv(argv: string[], protocol = "quibt"): string | null {
  return argv.find((item) => item.startsWith(`${protocol}://`)) ?? null;
}
