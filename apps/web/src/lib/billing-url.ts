import { desktopBridge } from "./desktop";

/**
 * Opens a Stripe URL. In the desktop app `will-navigate` blocks the in-window
 * redirect and opens it externally, so use a popup there (the window-open
 * handler hands it to the system browser) and keep the SPA usable.
 * Returns true when the page stayed put (desktop), false when it navigated away.
 */
export function openBillingUrl(url: string): boolean {
  if (desktopBridge()) {
    window.open(url, "_blank", "noopener");
    return true;
  }
  window.location.assign(url);
  return false;
}

/** Return URLs that route Stripe back through the `quibt://` deep link on desktop. */
export function billingReturnUrls():
  | { successUrl: string; cancelUrl: string }
  | Record<string, never> {
  if (!desktopBridge()) return {};
  const origin = window.location.origin;
  return {
    successUrl: `${origin}/billing?billing=success&app=1`,
    cancelUrl: `${origin}/billing?billing=canceled&app=1`,
  };
}
