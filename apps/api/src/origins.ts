import { normalizeRemoteConnectApi } from "@quibt/core";

/** The slice of `AppEnv` that decides which origins this deploy trusts. */
export interface TrustedOriginEnv {
  webOrigin: string;
  apiUrl: string;
  authUrl: string;
  trustedWebOrigins: string[];
  nodeEnv: string;
}

/** Owner-saved HTTPS tunnel (phone QR / webhooks) may call this API from another network. */
export function withPublicConnectOrigin(
  env: TrustedOriginEnv,
  publicOrigin: string | null | undefined,
): TrustedOriginEnv {
  const origin = normalizeRemoteConnectApi(publicOrigin);
  if (!origin || env.trustedWebOrigins.includes(origin)) return env;
  return { ...env, trustedWebOrigins: [...env.trustedWebOrigins, origin] };
}

/** App shells that are allowed to receive OAuth/billing redirects. */
const APP_SCHEMES = ["quibt://", "exp://"];

export function isTrustedOrigin(origin: string, env: TrustedOriginEnv) {
  if (!origin) return env.nodeEnv !== "production";
  if (origin === env.webOrigin || origin === env.apiUrl || origin === env.authUrl) return true;
  if (env.trustedWebOrigins.includes(origin)) return true;
  if (APP_SCHEMES.some((scheme) => origin.startsWith(scheme))) return true;
  try {
    const host = new URL(origin).hostname;
    return env.nodeEnv !== "production" && (host === "localhost" || host === "127.0.0.1");
  } catch {
    return false;
  }
}

/**
 * Validates a caller-supplied OAuth return URL with the same discipline as
 * `checkoutReturnUrl`: only the deploy's own web origin (or a native app
 * scheme) may be redirected to, and never with embedded credentials.
 * Anything else falls back to the server-owned callback.
 */
export function connectionCallbackUrl(
  requested: string | undefined,
  fallback: string,
  env: TrustedOriginEnv,
): string {
  if (!requested) return fallback;
  let url: URL;
  try {
    url = new URL(requested);
  } catch {
    return fallback;
  }
  if (url.username || url.password) return fallback;
  if (APP_SCHEMES.some((scheme) => requested.startsWith(scheme))) return requested;
  if (!url.protocol.startsWith("http")) return fallback;
  return isTrustedOrigin(url.origin, env) ? requested : fallback;
}

/** Adds the connection row id so the callback page knows what to finish. */
export function withConnectionId(callbackUrl: string, connectionId: string): string {
  try {
    const url = new URL(callbackUrl);
    url.searchParams.set("connectionId", connectionId);
    return url.toString();
  } catch {
    const separator = callbackUrl.includes("?") ? "&" : "?";
    return `${callbackUrl}${separator}connectionId=${encodeURIComponent(connectionId)}`;
  }
}
