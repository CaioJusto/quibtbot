export interface PendingOwnerEnrollment {
  token: string;
  expiresAt: number;
}

const FIRST_OWNER_SIGNUP_PATH = "/api/auth/sign-up/email";

export function validOwnerEnrollmentToken(
  pending: PendingOwnerEnrollment | null,
  now = Date.now(),
): string | null {
  if (!pending?.token.trim() || pending.expiresAt <= now) return null;
  return pending.token;
}

export function isFirstOwnerSignupRequest(requestUrl: string, webUrl: string): boolean {
  try {
    const request = new URL(requestUrl);
    const web = new URL(webUrl);
    return request.origin === web.origin && request.pathname === FIRST_OWNER_SIGNUP_PATH;
  } catch {
    return false;
  }
}

/** Kept for compatibility with older callers; exact-origin protection also covers a VPS. */
export const isLocalFirstOwnerSignupRequest = isFirstOwnerSignupRequest;

export function shouldClearOwnerEnrollment(statusCode: number): boolean {
  return (statusCode >= 200 && statusCode < 300) || statusCode === 403 || statusCode === 409;
}

export async function claimOwnerEnrollment(
  apiBase: string,
  credential: string | { code: string } | { token: string },
  fetchImpl: typeof fetch,
): Promise<PendingOwnerEnrollment> {
  const requestBody = typeof credential === "string" ? { code: credential } : credential;
  const response = await fetchImpl(`${apiBase.replace(/\/+$/, "")}/api/bootstrap/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(15_000),
  });
  const responseBody = (await response.json().catch(() => ({}))) as {
    enrollmentToken?: unknown;
    expiresAt?: unknown;
    message?: unknown;
  };
  if (!response.ok) {
    throw new Error(
      typeof responseBody.message === "string"
        ? responseBody.message
        : "Não foi possível preparar o proprietário.",
    );
  }
  const token =
    typeof responseBody.enrollmentToken === "string" ? responseBody.enrollmentToken.trim() : "";
  const expiresAt =
    typeof responseBody.expiresAt === "string" ? Date.parse(responseBody.expiresAt) : Number.NaN;
  if (!token || !Number.isFinite(expiresAt)) {
    throw new Error("O servidor devolveu um convite de proprietário inválido.");
  }
  return { token, expiresAt };
}
