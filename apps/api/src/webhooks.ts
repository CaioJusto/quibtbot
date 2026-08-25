import {
  generateWebhookEndpointId,
  generateWebhookSecret,
  hashWebhookSecret,
  webhookSecretMatches,
} from "@quibt/db";

export const WEBHOOK_MODEL_PAYLOAD_CHARS = 48_000;

/** Hono `bodyLimit` ceiling for `/hooks/*`: generous enough for a real event payload,
 * small enough that an unauthenticated or misbehaving sender cannot force this process
 * to buffer an unbounded body in memory. */
export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

export class WebhookPayloadError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "WebhookPayloadError";
  }
}

export type WebhookPromptInput = {
  configuredPrompt?: string;
  payload: unknown;
  receivedAt: Date;
  deliveryId?: string | null;
  eventName?: string | null;
};

type HeaderSource =
  | Headers
  | Record<string, string | undefined>
  | { get(name: string): string | null | undefined };

type InstructionKind = "configured" | "authenticated" | "default";

const INSTRUCTION_MARKERS: Record<InstructionKind, { open: string; close: string }> = {
  configured: {
    open: "[INSTRUÇÕES CONFIGURADAS PELO USUÁRIO]",
    close: "[/INSTRUÇÕES CONFIGURADAS PELO USUÁRIO]",
  },
  authenticated: {
    open: "[TAREFA AUTENTICADA DO WEBHOOK]",
    close: "[/TAREFA AUTENTICADA DO WEBHOOK]",
  },
  default: {
    open: "[INSTRUÇÕES PADRÃO DO WEBHOOK]",
    close: "[/INSTRUÇÕES PADRÃO DO WEBHOOK]",
  },
};

const PROTOCOL_MARKERS = [
  "[INSTRUÇÕES DO WEBHOOK]",
  "[/INSTRUÇÕES DO WEBHOOK]",
  INSTRUCTION_MARKERS.configured.open,
  INSTRUCTION_MARKERS.configured.close,
  INSTRUCTION_MARKERS.authenticated.open,
  INSTRUCTION_MARKERS.authenticated.close,
  INSTRUCTION_MARKERS.default.open,
  INSTRUCTION_MARKERS.default.close,
  "[DADOS NÃO CONFIÁVEIS DO EVENTO]",
  "[/DADOS NÃO CONFIÁVEIS DO EVENTO]",
  "[Payload truncado pelo Quibt]",
] as const;

const DELIVERY_HEADER_NAMES = [
  "idempotency-key",
  "x-webhook-id",
  "x-github-delivery",
  "webhook-id",
] as const;

const EVENT_HEADER_NAMES = [
  "x-github-event",
  "x-webhook-event",
  "x-event-type",
  "ce-type",
] as const;

function readHeader(headers: HeaderSource, name: string): string | null {
  const normalized = name.toLowerCase();
  if (headers instanceof Headers) {
    const value = headers.get(normalized) ?? headers.get(name);
    return value?.trim() || null;
  }
  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get(name: string): string | null | undefined }).get(normalized);
    return value?.trim() || null;
  }
  const record = headers as Record<string, string | undefined>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === normalized) {
      return value?.trim() || null;
    }
  }
  return null;
}

function readFirstHeader(headers: HeaderSource, names: readonly string[]): string | null {
  for (const name of names) {
    const value = readHeader(headers, name);
    if (value) return value;
  }
  return null;
}

/** Every emitter-controlled header this module reads (delivery id, event name) is clamped
 * to this many characters before it ever reaches a caller: it ends up in a Postgres unique
 * index key (`WebhookDelivery.externalId`) and in prompts/logs, so an emitter that sends a
 * multi-kilobyte header must not be able to blow either of those up. */
const WEBHOOK_HEADER_VALUE_MAX_CHARS = 200;

function clampHeaderValue(value: string | null): string | null {
  if (value === null) return null;
  return value.length > WEBHOOK_HEADER_VALUE_MAX_CHARS
    ? value.slice(0, WEBHOOK_HEADER_VALUE_MAX_CHARS)
    : value;
}

function normalizeContentType(contentType: string | undefined): string {
  return contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
}

// Neutralizes only the exact protocol tokens below; semantic, case, or spacing variants are out of scope.
export function neutralizeProtocolMarkers(text: string): string {
  let result = text;
  for (const marker of PROTOCOL_MARKERS) {
    const neutralized = marker.replace(/\[/g, "⟦").replace(/\]/g, "⟧");
    result = result.split(marker).join(neutralized);
  }
  return result;
}

function serializePayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function truncatePayloadText(text: string): string {
  if (text.length <= WEBHOOK_MODEL_PAYLOAD_CHARS) return text;
  const marker = "\n[Payload truncado pelo Quibt]";
  const maxBody = WEBHOOK_MODEL_PAYLOAD_CHARS - marker.length;
  return `${text.slice(0, maxBody)}${marker}`;
}

function resolveInstruction(
  configuredPrompt: string | undefined,
  payload: unknown,
): { kind: InstructionKind; body: string } {
  if (configuredPrompt?.trim()) {
    return { kind: "configured", body: configuredPrompt.trim() };
  }

  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (typeof record.task === "string" && record.task.trim()) {
      return { kind: "authenticated", body: record.task.trim() };
    }
    if (typeof record.message === "string" && record.message.trim()) {
      return { kind: "authenticated", body: record.message.trim() };
    }
  }

  return {
    kind: "default",
    body: "Faça um resumo conservador do evento recebido e proponha próximos passos seguros.",
  };
}

function formatMetadata(input: WebhookPromptInput): string {
  const lines = [`Recebido em: ${input.receivedAt.toISOString()}`];
  if (input.deliveryId) {
    lines.push(`Entrega: ${neutralizeProtocolMarkers(input.deliveryId)}`);
  }
  if (input.eventName) {
    lines.push(`Evento: ${neutralizeProtocolMarkers(input.eventName)}`);
  }
  return lines.join("\n");
}

function parseUrlEncodedPayload(raw: string): Record<string, string | string[]> {
  const params = new URLSearchParams(raw);
  const payload: Record<string, string | string[]> = {};
  for (const [key, value] of params.entries()) {
    const existing = payload[key];
    if (existing === undefined) {
      payload[key] = value;
      continue;
    }
    payload[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
  }
  return payload;
}

// `@quibt/db` is the authoritative boundary for the webhook secret (it is also the
// service that authenticates deliveries against it), so this module delegates to it
// instead of keeping a second SHA-256 + timingSafeEqual implementation that could drift.
export function newWebhookCredentials(): {
  endpointId: string;
  secret: string;
  secretHash: string;
} {
  const endpointId = generateWebhookEndpointId();
  const secret = generateWebhookSecret();
  return {
    endpointId,
    secret,
    secretHash: hashWebhookSecret(secret),
  };
}

export const secretMatches = webhookSecretMatches;

export function parseWebhookPayload(raw: string, contentType?: string): unknown {
  const normalized = normalizeContentType(contentType);
  if (normalized === "application/json") {
    // A blank body ("empty ping") is not malformed JSON — a lot of emitters use one to
    // verify an endpoint is alive. Treating it as `{}` keeps that a normal, accepted
    // event instead of a 400 the caller has to special-case.
    if (raw.trim() === "") return {};
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new WebhookPayloadError("Corpo JSON inválido.");
    }
  }
  if (normalized === "application/x-www-form-urlencoded") {
    return parseUrlEncodedPayload(raw);
  }
  return raw;
}

export function webhookPrompt(input: WebhookPromptInput): string {
  const instruction = resolveInstruction(input.configuredPrompt, input.payload);
  const markers = INSTRUCTION_MARKERS[instruction.kind];
  const instructionBody =
    instruction.kind === "authenticated"
      ? neutralizeProtocolMarkers(instruction.body)
      : instruction.body;
  const metadata = formatMetadata(input);
  const payloadText = truncatePayloadText(
    neutralizeProtocolMarkers(serializePayload(input.payload)),
  );

  return `${markers.open}
${instructionBody}
${markers.close}

[DADOS NÃO CONFIÁVEIS DO EVENTO]
${metadata}

${payloadText}
[/DADOS NÃO CONFIÁVEIS DO EVENTO]`;
}

export function readWebhookDeliveryId(headers: HeaderSource): string | null {
  return clampHeaderValue(readFirstHeader(headers, DELIVERY_HEADER_NAMES));
}

export function readWebhookEventName(headers: HeaderSource): string | null {
  return clampHeaderValue(readFirstHeader(headers, EVENT_HEADER_NAMES));
}

/**
 * The secret comes from whichever of the three documented sources the caller used:
 * the `Authorization: Bearer` header (preferred), the `X-Quibt-Webhook-Secret` header
 * (for emitters that cannot set a custom bearer scheme), or the last URL segment (for
 * emitters that cannot set custom headers at all). Callers pass `pathSecret` from the
 * route's own `:secret` param, never from anything else in the request.
 */
export function readWebhookSecret(
  headers: HeaderSource,
  pathSecret: string | null | undefined,
): string | null {
  const authorization = readHeader(headers, "authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice("bearer ".length).trim();
    if (token) return token;
  }
  const custom = readHeader(headers, "x-quibt-webhook-secret");
  if (custom) return custom;
  const fromPath = pathSecret?.trim();
  return fromPath || null;
}

/**
 * Strips one or more trailing slashes so a base URL concatenated with `/hooks/...`
 * never produces a doubled slash, regardless of whether the person pasted it with or
 * without one.
 */
export function normalizeWebhookBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * The one place that decides which base URL webhook credentials are minted from:
 * the deployment's own `webhookPublicUrl` setting when present, `env.apiUrl` otherwise.
 * This never reads a request's Host header — a spoofed Host must never rewrite a
 * credential a person is about to paste into an external system.
 */
export function resolveWebhookPublicBase(saved: string | null | undefined, apiUrl: string): string {
  const trimmed = saved?.trim();
  return normalizeWebhookBaseUrl(trimmed || apiUrl);
}

export interface WebhookCredentialParts {
  endpointUrl: string;
  secret: string;
  url: string;
}

/** Builds the two URLs a create/rotate response hands back, from an already-resolved base. */
export function buildWebhookCredential(input: {
  baseUrl: string;
  endpointId: string;
  secret: string;
}): WebhookCredentialParts {
  const base = normalizeWebhookBaseUrl(input.baseUrl);
  return {
    endpointUrl: `${base}/hooks/${input.endpointId}`,
    secret: input.secret,
    url: `${base}/hooks/${input.endpointId}/${input.secret}`,
  };
}
