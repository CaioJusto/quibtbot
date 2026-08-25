import type { Webhook, WebhookAttempt, WebhookCredential } from "@quibt/contracts";

/** Raised by `normalizeWebhookPublicUrl` so the panel can show a message instead of a stack. */
export class WebhookUrlError extends Error {}

const WEBHOOK_URL_ERROR_MESSAGE =
  "A URL pública precisa ser http ou https, sem usuário, senha, busca ou fragmento.";

/**
 * Strips one or more trailing slashes, mirroring the backend's own
 * `normalizeWebhookBaseUrl` (`apps/api/src/webhooks.ts`) so a base URL concatenated
 * with `/hooks/...` never doubles a slash, on either side of the wire.
 */
function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Validates and normalizes the deployment's public webhook URL, mirroring the same
 * rule the contract boundary enforces server-side (`isValidWebhookPublicUrl` in
 * `packages/contracts/src/domain.ts`): http(s) only, no embedded credentials, no
 * query string or fragment. Throws `WebhookUrlError` — never returns an unusable
 * value the panel could mistakenly show as saved.
 */
export function normalizeWebhookPublicUrl(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new WebhookUrlError(WEBHOOK_URL_ERROR_MESSAGE);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebhookUrlError(WEBHOOK_URL_ERROR_MESSAGE);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new WebhookUrlError(WEBHOOK_URL_ERROR_MESSAGE);
  }
  return trimTrailingSlashes(trimmed);
}

/**
 * Builds the two URLs a create/rotate response hands back, from an already-validated
 * public base URL. Same shape and concatenation as the backend's own
 * `buildWebhookCredential` (`apps/api/src/webhooks.ts`) — this module never re-derives
 * a base URL on its own, it only ever formats the one the server already resolved and
 * returned.
 */
/** Public Bearer endpoint only — never embeds the secret. Safe to show after the one-time card is gone. */
export function webhookPublicEndpoint(publicUrl: string | null, endpointId: string): string {
  const base = publicUrl ? trimTrailingSlashes(publicUrl.trim()) : "";
  return base ? `${base}/hooks/${endpointId}` : `/hooks/${endpointId}`;
}

export function buildWebhookCredential(
  publicUrl: string,
  endpointId: string,
  secret: string,
): WebhookCredential {
  const base = trimTrailingSlashes(publicUrl.trim());
  return {
    endpointUrl: `${base}/hooks/${endpointId}`,
    secret,
    url: `${base}/hooks/${endpointId}/${secret}`,
  };
}

/**
 * POSIX single-quote escaping for one shell word: closes the current quote, inserts
 * a literal quote via a separately-quoted escape, then reopens. Safe for any byte a
 * webhook secret or URL could contain, including embedded single quotes.
 */
export function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/** A copy-pasteable `curl` command that delivers a test event using the documented
 * `Authorization: Bearer` scheme — the credential's private URL is offered separately
 * for emitters that cannot set custom headers, so the command itself does not need it. */
export function webhookCurl(credential: WebhookCredential): string {
  return [
    "curl -X POST",
    shellQuote(credential.endpointUrl),
    "-H",
    shellQuote(`Authorization: Bearer ${credential.secret}`),
    "-H",
    shellQuote("Content-Type: application/json"),
    "-d",
    shellQuote("{}"),
  ].join(" ");
}

const WEBHOOK_EVENT_MAX_CHARS = 200;
const WEBHOOK_EVENT_MAX_COUNT = 20;

/** Turns the form's comma-separated events field into `CreateWebhookInput.eventTypes`:
 * trims each entry, drops blanks and duplicates, and clamps to the same limits the
 * contract enforces server-side so a rejected save is never a surprise. */
export function parseWebhookEventsInput(text: string): string[] {
  const seen = new Set<string>();
  const events: string[] = [];
  for (const raw of text.split(",")) {
    const trimmed = raw.trim().slice(0, WEBHOOK_EVENT_MAX_CHARS);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    events.push(trimmed);
    if (events.length >= WEBHOOK_EVENT_MAX_COUNT) break;
  }
  return events;
}

/** The inverse of `parseWebhookEventsInput`, for populating the form when editing. */
export function formatWebhookEventsInput(events: string[]): string {
  return events.join(", ");
}

const WEBHOOK_OUTCOME_LABELS: Record<WebhookAttempt["outcome"], string> = {
  accepted: "Aceito",
  duplicate: "Duplicado",
  ignored: "Ignorado",
  rejected: "Rejeitado",
};

export function webhookOutcomeLabel(outcome: WebhookAttempt["outcome"]): string {
  return WEBHOOK_OUTCOME_LABELS[outcome];
}

export function webhookActiveLabel(active: Webhook["active"]): string {
  return active ? "Ativo" : "Pausado";
}
