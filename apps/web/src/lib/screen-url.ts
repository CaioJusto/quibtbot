/**
 * The bot screen is served through a signed, short-lived capability URL:
 * `/novnc/<host-b64>/<port>/<expiresAt>.<signature>[.<mode>]<path>`. The signature is only checked
 * when the browser opens the connection, so a live noVNC session keeps working after its
 * capability expires — but *changing the iframe `src`* tears the session down and
 * reconnects. Thread snapshots now carry a signed URL when this caller holds control, so
 * the panel does not mint a new capability on every refresh. The string can still change
 * when a capability is re-signed.
 *
 * The policy here keeps the URL the iframe is showing stable while it is mounted, and only
 * takes a fresh one when the iframe is not mounted (a (re)mount needs a capability that is
 * still valid) or when the screen it points at is a different one.
 */

export const SCREEN_URL_RENEW_MARGIN_MS = 15_000;

export type ScreenCapability = {
  /** Everything that identifies *which* screen this URL opens, minus expiry and signature. */
  target: string;
  expiresAt: number;
};

const CAPABILITY_PATH =
  /^\/novnc\/([A-Za-z0-9_-]+)\/(\d+)\/(\d+)\.([A-Za-z0-9_-]+)(?:\.(view|control))?(\/.*)?$/;

function splitUrl(url: string) {
  const scheme = url.indexOf("://");
  if (scheme < 0) return { origin: "", path: url };
  const slash = url.indexOf("/", scheme + 3);
  if (slash < 0) return { origin: url, path: "/" };
  return { origin: url.slice(0, slash), path: url.slice(slash) };
}

/** Reads the signed capability out of a screen URL. Returns null for unsigned URLs. */
export function screenUrlCapability(url: string | null): ScreenCapability | null {
  if (!url) return null;
  const { origin, path } = splitUrl(url);
  const match = CAPABILITY_PATH.exec(path);
  if (!match) return null;
  const expiresAt = Number(match[3]);
  if (!Number.isFinite(expiresAt)) return null;
  const mode = match[5] ? `.${match[5]}` : "";
  return { target: `${origin}/${match[1]}/${match[2]}${mode}${match[6] ?? ""}`, expiresAt };
}

/** Milliseconds left on the capability. Unsigned URLs never expire on their own. */
export function screenUrlRemainingMs(url: string | null, now: number) {
  if (!url) return 0;
  const capability = screenUrlCapability(url);
  return capability ? capability.expiresAt - now : Number.POSITIVE_INFINITY;
}

function sameScreen(a: string, b: string) {
  if (a === b) return true;
  const left = screenUrlCapability(a);
  const right = screenUrlCapability(b);
  if (!left || !right) return false;
  return left.target === right.target;
}

export type ScreenUrlAction = "keep" | "swap" | "renew" | "reconnect";

export type ScreenUrlDecision = {
  /** What the iframe should show. `null` means "show nothing until a fresh URL arrives". */
  url: string | null;
  action: ScreenUrlAction;
};

/**
 * Decides what the screen iframe should point at.
 *
 * - the session dropped (`disconnected`): there is nothing left to preserve. Unmount the
 *   dead frame (`url: null`) and let the caller mint a new capability — noVNC does not
 *   re-handshake on its own, and the old capability is usually spent by then.
 * - mounted (`mountedAt` set): keep the current URL — the session is already open.
 *   Only a URL that opens a *different* screen replaces it.
 * - not mounted: take the freshest URL that will still be valid when the iframe mounts;
 *   if none is, answer `renew` so the caller can ask the API for a new one.
 */
export function decideScreenUrl(input: {
  current: string | null;
  next: string | null;
  /** Instant the iframe mounted, or `null` while it is not on screen. */
  mountedAt: number | null;
  now: number;
  /** The embedded viewer reported that its connection died. */
  disconnected?: boolean;
  renewMarginMs?: number;
}): ScreenUrlDecision {
  const { current, next, mountedAt, now } = input;
  const margin = input.renewMarginMs ?? SCREEN_URL_RENEW_MARGIN_MS;

  // Keeping a stable URL is what protects a *live* session; a dead one must be remounted,
  // otherwise the user stares at a frozen screen until they close and reopen the panel.
  if (input.disconnected) return { url: null, action: "reconnect" };

  if (current && mountedAt !== null) {
    // A missing next URL is the API saying this actor no longer holds the lease.
    // Keeping the last signed capability would leave an interactive socket up.
    if (!next) return { url: null, action: "reconnect" };
    if (sameScreen(current, next)) return { url: current, action: "keep" };
    return { url: next, action: "swap" };
  }

  const fresh = (url: string | null) => Boolean(url) && screenUrlRemainingMs(url, now) > margin;
  if (fresh(next)) return { url: next, action: next === current ? "keep" : "swap" };
  if (fresh(current)) return { url: current, action: "keep" };
  return { url: null, action: "renew" };
}

/**
 * Whether the app still has to ask the API for a screen URL.
 *
 * The thread snapshot only carries one when this caller holds the control lease *and* the
 * session already had a screen address written down. A session can be `running` with none —
 * taking control alone puts the row in that state — so a `null` in the snapshot is not proof
 * that there is no screen. Trusting it left the holder staring at a placeholder they could not
 * click. When the lease is ours, ask explicitly; the API discovers the address and records it.
 */
export function shouldFetchScreenUrl(input: {
  screenUrl: string | null | undefined;
  state: string;
  controlHolder: string;
  /** The computer panel or the full-screen viewer is on screen. */
  open: boolean;
}): boolean {
  if (input.screenUrl) return false;
  if (!input.open) return false;
  if (input.controlHolder !== "user") return false;
  return input.state === "running" || input.state === "booting";
}

/** Messages the embedded noVNC page (`infra/sandboxes/computer/embed.html`) posts up. */
export const SCREEN_MESSAGE = {
  connected: "quibt.screen.connected",
  disconnected: "quibt.screen.disconnected",
} as const;

export type ScreenFrameEvent = "connected" | "disconnected" | null;

/**
 * Reads a `message` event coming from the screen iframe.
 *
 * The frame is sandboxed without `allow-same-origin`, so its origin is the opaque `"null"`
 * and it cannot address the app's origin either. Identity is what makes this safe: only the
 * very window we mounted is accepted, which no other page or frame can forge.
 */
export function screenFrameEvent(
  event: { origin?: string; data?: unknown; source?: unknown } | null,
  frame: unknown,
  appOrigin: string,
): ScreenFrameEvent {
  if (!event || !frame || event.source !== frame) return null;
  const origin = event.origin ?? "";
  if (origin !== "null" && origin !== "" && origin !== appOrigin) return null;
  const data = event.data;
  const type = typeof data === "object" && data !== null ? (data as { type?: unknown }).type : null;
  if (type === SCREEN_MESSAGE.disconnected) return "disconnected";
  if (type === SCREEN_MESSAGE.connected) return "connected";
  return null;
}

/** How many times a screen is remounted before the user is told it will not come back. */
export const SCREEN_RECONNECT_LIMIT = 4;
export const SCREEN_RECONNECT_BASE_MS = 500;
export const SCREEN_RECONNECT_MAX_MS = 8_000;

export type ScreenReconnectPlan = {
  retry: boolean;
  delayMs: number;
  /** Attempt count to store for the next drop; a successful connect resets it to 0. */
  nextAttempt: number;
};

/** Backoff for a screen that keeps dropping, so a broken sandbox is not hammered. */
export function planScreenReconnect(attempt: number): ScreenReconnectPlan {
  const attempts = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  if (attempts >= SCREEN_RECONNECT_LIMIT) {
    return { retry: false, delayMs: 0, nextAttempt: attempts };
  }
  return {
    retry: true,
    delayMs: Math.min(SCREEN_RECONNECT_MAX_MS, SCREEN_RECONNECT_BASE_MS * 2 ** attempts),
    nextAttempt: attempts + 1,
  };
}

function pageHref(href?: string) {
  return href ?? (typeof window !== "undefined" ? window.location.href : "http://127.0.0.1/");
}

/**
 * A noVNC URL on another localhost port cannot be framed from the Vite origin
 * (the browser treats it as a different site and the sandbox has no cookies).
 */
export function embeddableScreenUrl(url: string | null, href?: string): string | null {
  if (!url) return null;
  try {
    const page = new URL(pageHref(href));
    const parsed = new URL(url, page.href);
    const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    const pagePort = page.port || (page.protocol === "https:" ? "443" : "80");
    if (local && parsed.port && parsed.port !== pagePort) return null;
    return parsed.toString();
  } catch {
    return url;
  }
}

export function screenIframeSandbox(url: string | null, href?: string) {
  if (!url) return undefined;
  try {
    return new URL(url, pageHref(href)).pathname.startsWith("/novnc/")
      ? "allow-scripts allow-pointer-lock"
      : undefined;
  } catch {
    return undefined;
  }
}
