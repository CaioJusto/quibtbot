import * as SecureStore from "expo-secure-store";

const SESSION_KEY = "quibt.session_token";

/**
 * Every request reads the token, and SecureStore is a keychain round-trip. Keep the last
 * known value in memory; save/clear are the only writers, so they refresh the cache.
 */
let cachedToken: string | undefined;

export async function loadSessionToken() {
  if (cachedToken !== undefined) return cachedToken;
  try {
    const current = await SecureStore.getItemAsync(SESSION_KEY);
    cachedToken = current ?? "";
    return cachedToken;
  } catch {
    // Leave the cache empty so a transient keychain error is retried next time.
    return "";
  }
}

export async function saveSessionToken(token: string) {
  await SecureStore.setItemAsync(SESSION_KEY, token);
  cachedToken = token;
}

export async function clearSessionToken() {
  cachedToken = "";
  try {
    await SecureStore.deleteItemAsync(SESSION_KEY);
  } catch {
    // The in-memory cache is already cleared, so requests stop carrying the token.
  }
}

export function tokenFromAuthResponse(res: Response, body: unknown) {
  const fromJson = jsonToken(body);
  if (fromJson) return fromJson;
  const cookies = res.headers.get("set-cookie") ?? "";
  const match = cookies.match(/better-auth\.session_token=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

function jsonToken(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  if (typeof record.token === "string" && record.token) return record.token;
  const session = record.session;
  if (
    session &&
    typeof session === "object" &&
    typeof (session as { token?: string }).token === "string"
  ) {
    return (session as { token: string }).token;
  }
  return "";
}
