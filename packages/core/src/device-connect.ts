import qrcode from "qrcode-generator";

/**
 * The phone talks to the same API the desktop talks to — never to the Electron process.
 * The QR answers both questions the app has on a cold start: which server to call (`api`)
 * and who is calling (`pair`, a one-time token minted from the session already signed in
 * on the computer). Without `pair` the phone still lands on the right server and asks for
 * a password, which is what older builds do.
 */
export const CONNECT_SCHEME = "quibt";
export const CONNECT_PATH = "connect";
export const BOOTSTRAP_PATH = "bootstrap";

export function connectDeepLink(apiBase: string, pairToken?: string | null): string {
  const url = new URL(`${CONNECT_SCHEME}://${CONNECT_PATH}`);
  url.searchParams.set("api", apiBase.replace(/\/+$/, ""));
  if (pairToken) url.searchParams.set("pair", pairToken);
  return url.toString();
}

/** First-install link. Its token is exchanged for an owner enrollment on the server. */
export function bootstrapDeepLink(apiBase: string, inviteToken: string): string {
  const url = new URL(`${CONNECT_SCHEME}://${BOOTSTRAP_PATH}`);
  url.searchParams.set("api", apiBase.replace(/\/+$/, ""));
  url.searchParams.set("token", inviteToken);
  return url.toString();
}

export function parseConnectDeepLink(raw: string): { api: string; pair?: string } | null {
  try {
    const url = new URL(raw);
    const path = (url.hostname || url.pathname.replace(/^\/+/, "")).replace(/\/$/, "");
    if (
      url.protocol !== `${CONNECT_SCHEME}:` &&
      url.protocol !== "https:" &&
      url.protocol !== "http:"
    ) {
      return null;
    }
    if (path !== CONNECT_PATH && path !== "connect") return null;
    const api = url.searchParams.get("api")?.trim();
    if (!api) return null;
    const pair = url.searchParams.get("pair")?.trim();
    return pair ? { api, pair } : { api };
  } catch {
    return null;
  }
}

/**
 * Um endereço de loopback só existe dentro da própria máquina: lido no celular, ele
 * aponta para o celular. Um QR com `127.0.0.1` é bem formado e mesmo assim nunca
 * conecta — quem gera precisa saber disso antes de desenhar o código, e quem lê
 * precisa poder dizer "não alcancei esse servidor" em vez de acusar o QR.
 */
export function connectLinkIsReachable(api: string): boolean {
  try {
    return !isLoopbackHost(new URL(api).hostname);
  } catch {
    return false;
  }
}

export type PhoneConnectReach = "lan" | "remote";

/** Where a Cloudflare Tunnel / Tailscale Funnel on this PC should point. */
export const LOCAL_PHONE_TUNNEL_TARGET = "http://127.0.0.1:5173";

export function localPhoneTunnelCommand(): string {
  return `cloudflared tunnel --url ${LOCAL_PHONE_TUNNEL_TARGET}`;
}

export function isLoopbackHost(host: string): boolean {
  const value = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

/**
 * HTTPS origin a phone can call from any network. HTTP, loopback, credentials,
 * query and fragment are refused — that URL goes in the QR.
 */
export function normalizeRemoteConnectApi(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (!url.hostname || isLoopbackHost(url.hostname)) return null;
  return url.origin;
}

export function defaultPhoneConnectReach(remoteApi: string | null | undefined): PhoneConnectReach {
  return normalizeRemoteConnectApi(remoteApi) ? "remote" : "lan";
}

/** Public/VPS origin, a user-owned HTTPS tunnel, or the LAN API on loopback. */
export function connectApiBase(input: {
  pageHost: string;
  pageOrigin: string;
  lanApi?: string | null;
  remoteApi?: string | null;
  reach?: PhoneConnectReach;
  localApiPort?: number;
}): string {
  const host = input.pageHost.trim().toLowerCase();
  // When Electron is already showing a VPS, that visible origin is the source of truth.
  // Never let a LAN address or an old tunnel setting redirect the phone elsewhere.
  if (!isLoopbackHost(host)) return input.pageOrigin.replace(/\/+$/, "");
  const remote = normalizeRemoteConnectApi(input.remoteApi);
  const reach = input.reach ?? defaultPhoneConnectReach(remote);
  if (reach === "remote" && remote) return remote;
  if (input.lanApi) return input.lanApi.replace(/\/+$/, "");
  return `http://${input.pageHost}:${input.localApiPort ?? 3100}`;
}

/**
 * O QR é desenhado aqui dentro, nunca por um serviço de terceiro: o link carrega uma
 * credencial de uso único, e mandá-la para fora do computador seria entregá-la de graça.
 * Correção de erro em "M" — sobra margem para leitura de longe sem inchar o código.
 */
export function qrSvg(data: string, size = 240): string {
  const qr = qrcode(0, "M");
  qr.addData(data);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4;
  const span = count + quiet * 2;
  let path = "";
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) path += `M${col + quiet} ${row + quiet}h1v1h-1z`;
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"`,
    ` viewBox="0 0 ${span} ${span}" shape-rendering="crispEdges" role="img">`,
    `<rect width="${span}" height="${span}" fill="#ffffff"/>`,
    `<path d="${path}" fill="#111113"/>`,
    "</svg>",
  ].join("");
}

/** O mesmo SVG como `src` de `<img>`, sem sair da máquina. */
export function qrImageSrc(data: string, size = 240): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(qrSvg(data, size))}`;
}
