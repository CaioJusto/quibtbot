export type WindowRevealState = {
  minimized: boolean;
  visible: boolean;
  focused: boolean;
};

export type WindowRevealAction = "restore" | "show" | "focus";

/**
 * A minimized window ignores `show()`, so a second launch (or a deep link) has to
 * restore it first and then take focus.
 */
export function windowRevealActions(state: WindowRevealState): WindowRevealAction[] {
  const actions: WindowRevealAction[] = [];
  if (state.minimized) actions.push("restore");
  if (!state.visible) actions.push("show");
  if (!state.focused) actions.push("focus");
  return actions;
}

export type FailedLoad = {
  isMainFrame: boolean;
  url: string;
  errorCode: number;
  /** Last URL the app asked for; a stale failure must not replace a newer navigation. */
  requestedUrl: string | null;
  offlineAvailable: boolean;
  destroyed: boolean;
};

/** -3 is ERR_ABORTED: in-window redirects (Stripe) and a second loadURL cancel the first. */
const ERR_ABORTED = -3;

/**
 * Chromium canonicalizes what it loads, so `loadURL("http://127.0.0.1:5173")` fails back as
 * `http://127.0.0.1:5173/`. Comparing the raw strings made the offline page unreachable in the
 * one case it exists for: `QUIBT_WEB_URL` (and its default) has no trailing slash, so the very
 * first load against a stack that is down looked like a stale failure.
 */
function sameTarget(requested: string, failed: string): boolean {
  try {
    return new URL(requested).href === new URL(failed).href;
  } catch {
    return requested === failed;
  }
}

export function shouldLoadOfflinePage(event: FailedLoad): boolean {
  if (!event.isMainFrame || event.destroyed || !event.offlineAvailable) return false;
  if (event.url.startsWith("file:") || event.errorCode === ERR_ABORTED) return false;
  return event.requestedUrl === null || sameTarget(event.requestedUrl, event.url);
}
