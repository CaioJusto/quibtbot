import { type ConnectionPollResult, pollForConnection } from "@quibt/core";

export const NATIVE_PLUGIN_CALLBACK = "quibt://plugins/callback";

/**
 * Where Composio (or the API) should send the browser after OAuth. Production
 * builds use the `quibt://` scheme. Expo Go uses `exp://`, which the API also
 * trusts. The web `/plugins/callback?app=1` bounce is no longer the default.
 */
export function pluginCallbackUrl(createUrl?: (path: string) => string): string {
  if (createUrl) {
    try {
      const url = createUrl("plugins/callback");
      if (url.startsWith("quibt://") || url.startsWith("exp://")) return url;
    } catch {
      // fall through to the production scheme
    }
  }
  return NATIVE_PLUGIN_CALLBACK;
}

export function connectionIdFromCallbackUrl(raw: string): string | null {
  try {
    const id = new URL(raw).searchParams.get("connectionId")?.trim();
    return id || null;
  } catch {
    return null;
  }
}

export function waitForPluginConnection(input: {
  connectionId: string;
  hasAuthorizationUrl: boolean;
  complete: (connectionId: string) => Promise<{ status?: string }>;
  cancelled: () => boolean;
  wait?: (ms: number) => Promise<void>;
}): Promise<ConnectionPollResult> {
  return pollForConnection({
    attempts: input.hasAuthorizationUrl ? 45 : 1,
    delayMs: 2_000,
    wait: input.wait,
    cancelled: input.cancelled,
    check: () => input.complete(input.connectionId),
  });
}

export async function openPluginAuthorization(input: {
  authorizationUrl: string;
  redirectUrl: string;
  openAuthSession?: (url: string, redirectUrl: string) => Promise<{ type: string; url?: string }>;
  openUrl: (url: string) => Promise<unknown>;
}): Promise<string | null> {
  if (input.openAuthSession) {
    const result = await input.openAuthSession(input.authorizationUrl, input.redirectUrl);
    if (result.type === "success" && result.url) return result.url;
    return null;
  }
  await input.openUrl(input.authorizationUrl);
  return null;
}
