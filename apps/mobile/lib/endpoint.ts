export const DEFAULT_API = process.env.EXPO_PUBLIC_API_URL ?? "http://127.0.0.1:3100";

export type EndpointResult = { ok: true; url: string } | { ok: false; error: string };

export function defaultApiBase() {
  return originOnly(DEFAULT_API) ?? DEFAULT_API.replace(/\/+$/, "");
}

export function normalizeApiBase(input: string): EndpointResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: "Informe a URL do servidor" };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, error: "Isso não parece uma URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Use uma URL http ou https" };
  }
  if (!parsed.hostname) return { ok: false, error: "Essa URL está sem host" };
  if (parsed.protocol === "http:" && !isSafeHttpHost(parsed.hostname)) {
    return {
      ok: false,
      error: "Use https:// ou um endereço Tailscale. A rede Wi-Fi comum não protege sua sessão.",
    };
  }
  const url = `${parsed.protocol}//${parsed.host}`;
  return { ok: true, url };
}

export function displayApiHost(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.host;
  } catch {
    return url;
  }
}

export function usesCustomApiBase(url: string, fallback = defaultApiBase()) {
  return url !== fallback;
}

export function apiBaseWarning(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" && !isSafeHttpHost(parsed.hostname)) {
      return "Use https:// ou Tailscale. HTTP na rede Wi-Fi comum não protege sua sessão.";
    }
  } catch {
    return null;
  }
  return null;
}

export const PROBE_TIMEOUT_MS = 4_000;
export const PROBE_ATTEMPTS = 2;

export async function probeApiBase(
  input: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EndpointResult> {
  const parsed = normalizeApiBase(input);
  if (!parsed.ok) return parsed;
  let last: EndpointResult = {
    ok: false,
    error: "Não foi possível alcançar esse servidor",
  };
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
    const result = await probeOnce(parsed, fetchImpl);
    if (result.ok) return result;
    // Host answered, but it is not Quibt: retrying will not change that.
    if (result.error.includes("não parece um servidor")) return result;
    last = result;
  }
  return last;
}

async function probeOnce(
  parsed: Extract<EndpointResult, { ok: true }>,
  fetchImpl: typeof fetch,
): Promise<EndpointResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${parsed.url}/rpc/health`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "quibt://" },
      body: JSON.stringify({ json: {} }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as {
      json?: { ok?: boolean };
      error?: { message?: string };
    };
    if (!res.ok || body.error || body.json?.ok !== true) {
      return { ok: false, error: "Essa URL não parece um servidor Quibt Bot" };
    }
    return parsed;
  } catch {
    return { ok: false, error: "Não foi possível alcançar esse servidor" };
  } finally {
    clearTimeout(timer);
  }
}

function originOnly(value: string) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function isSafeHttpHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  // Tailscale: a rede privada continua privada mesmo saindo de casa, e é o caminho
  // que a documentação do gateway recomenda para o celular. O tráfego já vai cifrado
  // pelo WireGuard, então exigir https aqui só impediria de digitar o endereço.
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}$/.test(host)) return true;
  if (host.endsWith(".ts.net")) return true;
  if (process.env.EXPO_PUBLIC_ALLOW_INSECURE_LAN === "true") {
    if (host.endsWith(".local")) return true;
    if (/^10(?:\.\d{1,3}){3}$/.test(host)) return true;
    if (/^192\.168(?:\.\d{1,3}){2}$/.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}$/.test(host)) return true;
  }
  return false;
}
