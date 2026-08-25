const SESSION_KEY = "quibt.session_token";

function webStorage() {
  return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
}

export async function loadSessionToken() {
  const storage = webStorage();
  if (!storage) return "";
  return storage.getItem(SESSION_KEY) ?? "";
}

export async function saveSessionToken(token: string) {
  webStorage()?.setItem(SESSION_KEY, token);
}

export async function clearSessionToken() {
  webStorage()?.removeItem(SESSION_KEY);
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
