import { BOX_PUBLIC_PROXY_ENV } from "@quibt/core";
import type { Clock } from "./orchestrator.js";

export const HEALTH_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;
export const HTTP_TIMEOUT_MS = 10_000;
export const MAX_HTTP_RETRIES = 3;

export type DeploymentOwnerProbe =
  | { ok: true; needsFirstOwner: boolean }
  | { ok: false; error: string };

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForReady(
  readyUrl: string,
  fetchImpl: typeof fetch,
  clock: Clock,
): Promise<boolean> {
  for (const delay of HEALTH_BACKOFF_MS) {
    try {
      const res = await fetchWithRetry(
        readyUrl,
        { signal: AbortSignal.timeout(Math.min(delay, HTTP_TIMEOUT_MS)) },
        fetchImpl,
        1,
      );
      if (res.ok) return true;
    } catch {
      // retry
    }
    await clock.sleep(delay);
  }
  return false;
}

export async function fetchWithRetry(
  input: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
  retries = MAX_HTTP_RETRIES,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const res = await fetchImpl(input, init);
      if (res.status === 429 || res.status >= 500) {
        if (attempt + 1 >= retries) return res;
        const retryAfter = parseRetryAfterMs(res.headers.get("Retry-After"));
        await sleepMs(retryAfter ?? 250 * (attempt + 1));
        continue;
      }
      return res;
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= retries) break;
      await sleepMs(250 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("request failed");
}

export async function probeDeploymentNeedsFirstOwner(
  apiBase: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeploymentOwnerProbe> {
  let lastError = "deployment health probe unreachable";

  for (let attempt = 0; attempt < MAX_HTTP_RETRIES; attempt += 1) {
    try {
      const res = await fetchWithRetry(
        `${apiBase}/rpc/health`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: {} }),
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        },
        fetchImpl,
        1,
      );

      if (res.status === 429 || res.status >= 500) {
        lastError = `deployment health probe returned ${res.status}`;
        if (attempt + 1 >= MAX_HTTP_RETRIES) {
          return { ok: false, error: lastError };
        }
        const retryAfter = parseRetryAfterMs(res.headers.get("Retry-After"));
        await sleepMs(retryAfter ?? 250 * (attempt + 1));
        continue;
      }

      if (!res.ok) {
        return { ok: false, error: `deployment health probe returned ${res.status}` };
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { ok: false, error: "deployment health probe returned malformed JSON" };
      }

      const needsFirstOwner = (body as { json?: { needsFirstOwner?: unknown } })?.json
        ?.needsFirstOwner;
      if (needsFirstOwner !== true && needsFirstOwner !== false) {
        return {
          ok: false,
          error: "deployment health probe missing explicit needsFirstOwner boolean",
        };
      }

      return { ok: true, needsFirstOwner };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "deployment health probe unreachable";
      if (attempt + 1 < MAX_HTTP_RETRIES) {
        await sleepMs(250 * (attempt + 1));
      }
    }
  }

  return { ok: false, error: lastError };
}

export async function deploymentNeedsFirstOwner(
  apiBase: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const probe = await probeDeploymentNeedsFirstOwner(apiBase, fetchImpl);
  if (!probe.ok) {
    throw new Error(probe.error);
  }
  return probe.needsFirstOwner;
}

/**
 * A API que o INSTALADOR sonda, sempre no próprio host. `API_URL` é o endereço dos
 * clientes (navegador, celular) e numa instalação pública vira `https://…sslip.io` —
 * atrás do Caddy, que só sobe depois da migração. Sondar esse endereço aqui derrubava
 * o passo `health` em toda instalação pública: nada servia https ainda.
 */
export function apiBaseUrl(envValues: Record<string, string>, publicUrl: string): string {
  if (envValues.QUIBT_PUBLIC_HOST || envValues[BOX_PUBLIC_PROXY_ENV]) {
    return "http://127.0.0.1:3100";
  }
  const api = envValues.API_URL?.replace(/\/+$/, "");
  if (api) return api;
  try {
    const origin = new URL(publicUrl);
    origin.port = "3100";
    return origin.toString().replace(/\/$/, "");
  } catch {
    return "http://127.0.0.1:3100";
  }
}

export function apiReadyUrl(envValues: Record<string, string>, publicUrl: string): string {
  return `${apiBaseUrl(envValues, publicUrl)}/ready`;
}

export const CLAIMED_PAIRING_INSTRUCTION =
  "This server already has an owner. Approve pairing from an authenticated client (Settings → Devices).";
