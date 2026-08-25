import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

const SENSITIVE_FORWARD_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "proxy-authenticate",
  "proxy-authorization",
]);
const SENSITIVE_RESPONSE_HEADERS = new Set(["clear-site-data", "set-cookie", "set-cookie2"]);

export function resolveNovncTarget(url: string | undefined, secret: string, now = Date.now()) {
  const match = url?.match(
    /^\/novnc\/([A-Za-z0-9_-]+)\/(\d+)\/(\d+)\.([A-Za-z0-9_-]{43})\.(view|control)(\/[^?]*)?(\?.*)?$/,
  );
  if (!match) return null;
  const hostname = Buffer.from(match[1]!, "base64url").toString("utf8");
  const port = Number(match[2]);
  const expiresAt = Number(match[3]);
  const signature = match[4]!;
  const mode = match[5] as "view" | "control";
  const pathname = match[6] || "/";
  let targetPath = `${pathname}${match[7] || ""}`;
  if (!isAllowedTargetName(hostname)) return null;
  if (!Number.isInteger(port) || port < 1024 || port > 65_535 || expiresAt < now) return null;
  const expected = createHmac("sha256", secret)
    .update(`${hostname}:${port}:${expiresAt}:${mode}`)
    .digest("base64url");
  const suppliedBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (
    suppliedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    return null;
  }
  const viewOnly = mode === "view";
  // The custom embed is the policy enforcement point for keyboard/mouse input. Ignore any
  // client-supplied override and restore the permission carried by the signed capability.
  if (pathname.endsWith("/embed.html")) {
    const target = new URL(targetPath, "http://screen.local");
    target.searchParams.set("view_only", String(viewOnly));
    targetPath = `${target.pathname}${target.search}`;
  }
  return { hostname, port, path: targetPath, viewOnly, expiresAt };
}

function isAllowedTargetName(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    /^10\.(?:\d{1,3}\.){2}\d{1,3}$/.test(hostname) ||
    /^172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3})\.\d{1,3}$/.test(hostname) ||
    /^192\.168\.(?:\d{1,3})\.\d{1,3}$/.test(hostname) ||
    /^quibt-bot-[a-zA-Z0-9_.-]+$/.test(hostname)
  );
}

export function safeProxyHeaders(headers: IncomingHttpHeaders) {
  return Object.fromEntries(
    Object.entries(headers).filter(([key, value]) => {
      return value != null && !SENSITIVE_FORWARD_HEADERS.has(key.toLowerCase());
    }),
  );
}

export function safeProxyResponseHeaders(headers: IncomingHttpHeaders) {
  return Object.fromEntries(
    Object.entries(headers).filter(([key, value]) => {
      return value != null && !SENSITIVE_RESPONSE_HEADERS.has(key.toLowerCase());
    }),
  );
}

/**
 * Pair the browser socket with the upstream noVNC socket so a remount or a failed
 * handshake cannot leave websockify holding the connection until it runs out of FDs.
 */
export function bindProxySocketLifetime(
  client: { on: (event: string, listener: () => void) => void; destroy: () => void },
  upstream: { on: (event: string, listener: () => void) => void; destroy: () => void },
  /**
   * Quando a permissão assinada expira, este socket morre junto.
   *
   * O `view_only` do noVNC é imposto pelo JavaScript do cliente e a assinatura só
   * guardava o aperto de mão: um socket já aberto seguia aceitando teclado e mouse
   * para sempre — inclusive depois de o controle voltar para o bot ou passar para
   * outra pessoa. Agora a conexão tem prazo, e reconectar exige uma permissão nova,
   * que o servidor só assina para quem ainda tem o controle.
   */
  expiresAt?: number,
  now: () => number = Date.now,
) {
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    client.destroy();
    upstream.destroy();
  };
  if (expiresAt !== undefined) {
    const remaining = expiresAt - now();
    if (remaining <= 0) {
      close();
      return close;
    }
    timer = setTimeout(close, remaining);
    timer.unref?.();
  }
  client.on("close", close);
  client.on("error", close);
  upstream.on("close", close);
  upstream.on("error", close);
  return close;
}

export function stripSensitiveHandshakeHeaders(response: Buffer) {
  const end = response.indexOf("\r\n\r\n");
  if (end < 0) return null;
  const lines = response.subarray(0, end).toString("latin1").split("\r\n");
  const safeLines = lines.filter((line, index) => {
    if (index === 0) return true;
    const separator = line.indexOf(":");
    const name = separator < 0 ? line : line.slice(0, separator);
    return !SENSITIVE_RESPONSE_HEADERS.has(name.trim().toLowerCase());
  });
  return Buffer.concat([
    Buffer.from(`${safeLines.join("\r\n")}\r\n\r\n`, "latin1"),
    response.subarray(end + 4),
  ]);
}
