import { createHmac } from "node:crypto";

/** Long enough that a remount after a brief drop still has a valid handshake. */
export const SCREEN_PROXY_TTL_MS = 300_000;

export function addScreenProxyCapability(
  url: string,
  secret: string,
  proxyOrigin: string,
  now = Date.now(),
): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" || !parsed.hostname || !parsed.port) return url;
    const expiresAt = now + SCREEN_PROXY_TTL_MS;
    const target = Buffer.from(parsed.hostname).toString("base64url");
    const targetPath = `${parsed.pathname}${parsed.search}`;
    const mode = parsed.searchParams.get("view_only") === "true" ? "view" : "control";
    // A capacidade vale para o servidor de tela inteiro, não para um arquivo só: o
    // cliente noVNC busca scripts relativos e abre o WebSocket em outro caminho, e
    // uma assinatura presa ao caminho fazia todos eles voltarem 403 — tela preta.
    // O modo, porém, faz parte da assinatura: uma URL de observação nunca pode virar
    // uma URL de controle apenas trocando `view_only=false`.
    const signature = createHmac("sha256", secret)
      .update(`${parsed.hostname}:${parsed.port}:${expiresAt}:${mode}`)
      .digest("base64url");
    const origin = new URL(proxyOrigin).origin;
    return `${origin}/novnc/${target}/${parsed.port}/${expiresAt}.${signature}.${mode}${targetPath}`;
  } catch {
    return url;
  }
}

export function withViewOnly(url: string, viewOnly: boolean) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("view_only", viewOnly ? "true" : "false");
    return parsed.toString();
  } catch {
    const join = url.includes("?") ? "&" : "?";
    return `${url}${join}view_only=${viewOnly ? "true" : "false"}`;
  }
}

/** Sign a stored session URL. Returns null when there is nothing to drive. */
export function signStoredScreenUrl(
  rawUrl: string | null | undefined,
  secret: string,
  proxyOrigin: string,
  viewOnly = false,
): string | null {
  if (!rawUrl) return null;
  return addScreenProxyCapability(withViewOnly(rawUrl, viewOnly), secret, proxyOrigin);
}
