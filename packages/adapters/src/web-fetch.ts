import { type ResolveHost, validatePublicHttpsEndpoint } from "./mcp-http.js";

export const MAX_WEB_FETCH_BYTES = 512 * 1024;
export const MAX_WEB_FETCH_REDIRECTS = 3;

const ALLOWED_CONTENT_TYPES = new Set(["text/html", "text/plain", "application/xhtml+xml"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CREDENTIAL_QUERY_KEY =
  /(^|[_-])(access[_-]?token|api[_-]?key|auth|authorization|credential|password|secret|signature|token)([_-]|$)/i;

export interface WebFetchResult {
  finalUrl: string;
  title: string | null;
  text: string;
}

/**
 * Validate before persisting a tool effect. Authenticated URLs are deliberately unsupported:
 * the fetcher has no cookie/header input and credential-shaped query values never enter history.
 */
export function webFetchRequestForTranscript(args: Record<string, unknown>) {
  const source = String(args.url ?? "").trim();
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error("web_fetch URL must be a valid HTTPS URL");
  }
  if (url.username || url.password) {
    throw new Error("web_fetch does not accept credentials in URLs");
  }
  url.hash = "";
  assertNoCredentialQuery(url);
  return { url: url.href };
}

export async function webFetch(
  source: string,
  options: {
    fetchImpl?: typeof fetch;
    resolver?: ResolveHost;
    signal?: AbortSignal;
  } = {},
): Promise<WebFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let current = await validatePublicHttpsEndpoint(source, "web_fetch URL", options.resolver);
  current.hash = "";
  assertNoCredentialQuery(current);

  for (let redirects = 0; ; redirects += 1) {
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000);
    const response = await fetchImpl(current, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "text/html, application/xhtml+xml, text/plain;q=0.9",
      },
      signal,
    });

    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel();
      if (redirects >= MAX_WEB_FETCH_REDIRECTS) {
        throw new Error(`web_fetch exceeded ${MAX_WEB_FETCH_REDIRECTS} redirects`);
      }
      const location = response.headers.get("location");
      if (!location) throw new Error("web_fetch redirect is missing a location");
      const next = new URL(location, current);
      current = await validatePublicHttpsEndpoint(
        next.href,
        "web_fetch redirect",
        options.resolver,
      );
      current.hash = "";
      assertNoCredentialQuery(current);
      continue;
    }

    if (!response.ok) throw new Error(`web_fetch received HTTP ${response.status}`);
    const contentType = (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (!contentType || !ALLOWED_CONTENT_TYPES.has(contentType)) {
      throw new Error(`web_fetch does not allow content type ${contentType || "unknown"}`);
    }

    const body = new TextDecoder().decode(await readLimitedBody(response));
    if (contentType === "text/plain") {
      return { finalUrl: current.href, title: null, text: normalizeText(body) };
    }
    return {
      finalUrl: current.href,
      title: extractTitle(body),
      text: htmlToText(body),
    };
  }
}

function assertNoCredentialQuery(url: URL) {
  for (const key of url.searchParams.keys()) {
    if (CREDENTIAL_QUERY_KEY.test(key)) {
      throw new Error("web_fetch does not accept credential query parameters");
    }
  }
}

async function readLimitedBody(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_WEB_FETCH_BYTES) throw new Error("web_fetch response is too large");
  if (!response.body) {
    const bytes = new TextEncoder().encode(await response.text());
    if (bytes.byteLength > MAX_WEB_FETCH_BYTES) throw new Error("web_fetch response is too large");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_WEB_FETCH_BYTES) {
      await reader.cancel();
      throw new Error("web_fetch response is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function extractTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const title = match ? normalizeText(decodeEntities(match[1] ?? "")) : "";
  return title ? title.slice(0, 500) : null;
}

function htmlToText(html: string): string {
  const withoutHidden = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(head|script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(br|hr)\b[^>]*\/?\s*>/gi, "\n")
    .replace(
      /<\/(address|article|aside|blockquote|div|footer|h[1-6]|header|li|main|nav|p|pre|section|table|tr)\s*>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, " ");
  return normalizeText(decodeEntities(withoutHidden));
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code[0] !== "#") return named[code.toLowerCase()] ?? entity;
    const point =
      code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
    return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff
      ? String.fromCodePoint(point)
      : entity;
  });
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
