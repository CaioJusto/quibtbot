import { normalizeBootstrapCode } from "@quibt/core/bootstrap-invite";
import { MOBILE_REQUEST_TIMEOUT_MS, saveApiBase } from "./api";
import { normalizeApiBase } from "./endpoint";
import { saveEnrollmentToken } from "./enrollment-store";

export {
  BOOTSTRAP_ENROLLMENT_KEY,
  clearEnrollmentToken,
  hasEnrollmentToken,
  isTerminalEnrollmentSignupFailure,
  loadEnrollmentToken,
  saveEnrollmentToken,
} from "./enrollment-store";

export type BootstrapPairingResult =
  | { ok: true; redirectTo: "/sign-up" }
  | { ok: false; error: string; terminal?: boolean; notBootstrap?: boolean };

export function normalizeInstallationCode(code: string): string {
  return normalizeBootstrapCode(code);
}

export function parseBootstrapDeepLink(raw: string): { api: string; token: string } | null {
  try {
    const url = new URL(raw);
    const path = (url.hostname || url.pathname.replace(/^\/+/, "")).replace(/\/$/, "");
    if (url.protocol !== "quibt:") return null;
    if (path !== "bootstrap") return null;
    const api = url.searchParams.get("api")?.trim();
    const token = url.searchParams.get("token")?.trim();
    if (!api || !token) return null;
    return { api, token };
  } catch {
    return null;
  }
}

function claimMessage(body: unknown, fallback: string): string {
  if (typeof body === "object" && body && "message" in body) {
    return String((body as { message?: string }).message ?? fallback);
  }
  return fallback;
}

async function persistBootstrapClaim(
  apiBase: string,
  enrollmentToken: string,
): Promise<BootstrapPairingResult> {
  const normalized = normalizeApiBase(apiBase);
  if (!normalized.ok) return { ok: false, error: normalized.error, terminal: true };
  const saved = await saveApiBase(normalized.url);
  if (!saved.ok) return { ok: false, error: saved.error, terminal: true };
  await saveEnrollmentToken(enrollmentToken);
  return { ok: true, redirectTo: "/sign-up" };
}

async function exchangeInstallationInvite(
  apiBase: string,
  credential: { code: string } | { token: string },
  fetchImpl: typeof fetch,
): Promise<BootstrapPairingResult> {
  const normalizedBase = normalizeApiBase(apiBase);
  if (!normalizedBase.ok) return { ok: false, error: normalizedBase.error, terminal: true };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MOBILE_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${normalizedBase.url}/api/bootstrap/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "quibt://" },
      body: JSON.stringify(credential),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        error: claimMessage(body, "Não foi possível validar o convite."),
        terminal: res.status === 400,
      };
    }
    const enrollmentToken = (body as { enrollmentToken?: string }).enrollmentToken;
    if (!enrollmentToken?.trim()) {
      return { ok: false, error: "Resposta inválida do servidor.", terminal: true };
    }
    return persistBootstrapClaim(normalizedBase.url, enrollmentToken.trim());
  } catch {
    if (controller.signal.aborted) {
      return {
        ok: false,
        error: "A conexão demorou demais. Verifique sua internet e tente novamente.",
      };
    }
    return { ok: false, error: "Não foi possível alcançar o servidor." };
  } finally {
    clearTimeout(timer);
  }
}

export async function claimInstallation(
  apiBase: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BootstrapPairingResult> {
  const normalizedCode = normalizeInstallationCode(code);
  if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(normalizedCode)) {
    return { ok: false, error: "Código inválido.", terminal: true };
  }
  return exchangeInstallationInvite(apiBase, { code: normalizedCode }, fetchImpl);
}

/** Persist only after a UI has shown the destination host and the person confirmed it. */
export async function confirmBootstrapLink(
  raw: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BootstrapPairingResult> {
  const parsed = parseBootstrapDeepLink(raw);
  if (!parsed) return { ok: false, notBootstrap: true, error: "" };
  return exchangeInstallationInvite(parsed.api, { token: parsed.token }, fetchImpl);
}
