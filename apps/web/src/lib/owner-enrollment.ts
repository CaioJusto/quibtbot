import { normalizeBootstrapCode } from "@quibt/core/bootstrap-invite";

export interface WebOwnerEnrollment {
  token: string;
  expiresAt: number;
}

export type OwnerEnrollmentClaim =
  | { ok: true; enrollment: WebOwnerEnrollment }
  | { ok: false; message: string };

export async function claimOwnerEnrollmentCode(
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OwnerEnrollmentClaim> {
  const normalized = normalizeBootstrapCode(code);
  if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(normalized)) {
    return { ok: false, message: "Digite o código de oito caracteres do instalador." };
  }

  const response = await fetchImpl("/api/bootstrap/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ code: normalized }),
  }).catch(() => null);
  if (!response) {
    return { ok: false, message: "Não foi possível alcançar o servidor." };
  }

  const body = (await response.json().catch(() => ({}))) as {
    enrollmentToken?: unknown;
    expiresAt?: unknown;
    message?: unknown;
  };
  if (!response.ok) {
    return {
      ok: false,
      message:
        typeof body.message === "string" ? body.message : "Não foi possível validar o convite.",
    };
  }

  const token = typeof body.enrollmentToken === "string" ? body.enrollmentToken.trim() : "";
  const expiresAt = typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : Number.NaN;
  if (!token || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return { ok: false, message: "O servidor devolveu um convite inválido." };
  }
  return { ok: true, enrollment: { token, expiresAt } };
}

export function validWebOwnerEnrollment(
  enrollment: WebOwnerEnrollment | null,
  now = Date.now(),
): string | null {
  if (!enrollment?.token.trim() || enrollment.expiresAt <= now) return null;
  return enrollment.token;
}
