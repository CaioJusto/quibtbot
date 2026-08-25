import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  Actor,
  RunStatus,
  WebhookAttempt as WebhookAttemptDTO,
  Webhook as WebhookDTO,
} from "@quibt/contracts";
import { WebhookOutcome } from "@quibt/contracts";
import { Prisma, type PrismaClient, type Webhook as WebhookRow } from "./client.js";
import { IsolationError } from "./scope.js";

/**
 * Local, minimal shape of the wakeup driver. `@quibt/db` cannot depend on
 * `@quibt/adapter-kit` (that would make persistence depend on the adapter layer), so this
 * is a structural subset of `WakeupDriver["enqueue"]` that any real driver already satisfies.
 */
export interface WebhookWakeup {
  enqueue(job: { name: string; payload: Record<string, unknown>; jobKey?: string }): Promise<void>;
}

export interface WebhookReceiveEvent {
  payload: unknown;
  deliveryId?: string | null;
  eventName?: string | null;
}

export interface WebhookReceiveInput {
  endpointId: string;
  secret: string;
  event: WebhookReceiveEvent;
}

export interface WebhookAuthorizeMetadata {
  eventName?: string | null;
  deliveryId?: string | null;
}

export interface WebhookTestRunEvent {
  payload?: unknown;
  eventName?: string | null;
}

export type WebhookReceiveOutcome = "accepted" | "duplicate" | "ignored" | "rejected";

export interface WebhookReceiveResult {
  outcome: WebhookReceiveOutcome;
  duplicate: boolean;
  statusCode: number;
  runId: string | null;
  taskId: string | null;
  reason?: string;
}

export interface WebhookBuildPromptInput {
  webhook: WebhookDTO;
  event: WebhookReceiveEvent;
  receivedAt: Date;
  deliveryId: string | null;
}

export interface WebhookServiceDeps {
  prisma: PrismaClient;
  wakeup: WebhookWakeup;
  /** Injectable clock so the persistent rate limit and the unfinished-run cap are testable. */
  now?: () => Date;
  /**
   * The prompt is built from untrusted payload data, so it must never run before
   * `secretMatches` (and the rest of the validations) confirm the caller is authorized.
   * Task 4 supplies the real `webhookPrompt` helper here; tests use a deterministic stub.
   */
  buildPrompt(input: WebhookBuildPromptInput): string;
}

export interface CreateWebhookServiceInput {
  botId: string;
  name: string;
  prompt?: string;
  active?: boolean;
  eventTypes?: string[];
}

export interface UpdateWebhookServiceInput {
  webhookId: string;
  name?: string;
  prompt?: string;
  active?: boolean;
  eventTypes?: string[];
}

export class WebhookNotFoundError extends Error {
  constructor(message = "Webhook not found") {
    super(message);
    this.name = "WebhookNotFoundError";
  }
}

/** Requests within the trailing minute, counted from persisted attempts so the limit
 * survives a process restart (a rate limit kept only in memory is not a rate limit). */
const WEBHOOK_RATE_LIMIT_PER_MINUTE = 10;
const WEBHOOK_RATE_LIMIT_WINDOW_MS = 60_000;
/** Unfinished work per webhook; protects a bot from an event source that fires faster
 * than the bot can work through the backlog. */
const WEBHOOK_MAX_NONTERMINAL_RUNS = 3;
const NONTERMINAL_RUN_STATUSES: RunStatus[] = [
  "queued",
  "leased",
  "running",
  "waiting_input",
  "waiting_takeover",
];

/** `attempts()` never trusts a caller-supplied limit outright: it is always clamped to
 * this range, independent of any bound the RPC layer already enforces. */
const WEBHOOK_ATTEMPTS_MIN_LIMIT = 1;
const WEBHOOK_ATTEMPTS_MAX_LIMIT = 100;
const WEBHOOK_ATTEMPTS_DEFAULT_LIMIT = 50;

/**
 * `@quibt/db` is the authoritative boundary for the webhook secret: everything that
 * hashes, compares, or generates it lives here so `apps/api` (and any other consumer)
 * delegates to this implementation instead of keeping a second copy that could drift.
 */
export function hashWebhookSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * The service is the authoritative boundary for the secret: it hashes and compares here
 * instead of trusting a result computed elsewhere, and it never returns the hash in a
 * public result (CRUD reads only ever expose `WebhookDTO`, which has no hash field).
 */
export function webhookSecretMatches(secret: string, hash: string): boolean {
  const computed = hashWebhookSecret(secret);
  if (computed.length !== hash.length) return false;
  try {
    return timingSafeEqual(Buffer.from(computed, "utf8"), Buffer.from(hash, "utf8"));
  } catch {
    return false;
  }
}

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

export function generateWebhookEndpointId(): string {
  return `wh_${randomBytes(16).toString("base64url")}`;
}

function mapWebhook(row: {
  id: string;
  endpointId: string;
  botId: string;
  name: string;
  prompt: string;
  active: boolean;
  eventTypes: string[];
  deliveryCount: number;
  lastReceivedAt: Date | null;
  lastRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): WebhookDTO {
  return {
    id: row.id,
    endpointId: row.endpointId,
    botId: row.botId,
    name: row.name,
    prompt: row.prompt,
    active: row.active,
    eventTypes: row.eventTypes,
    deliveryCount: row.deliveryCount,
    lastReceivedAt: row.lastReceivedAt?.toISOString() ?? null,
    lastRunId: row.lastRunId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapAttempt(row: {
  id: string;
  webhookId: string;
  receivedAt: Date;
  outcome: string;
  statusCode: number;
  eventName: string | null;
  preview: string | null;
  deliveryId: string | null;
  runId: string | null;
  reason: string | null;
}): WebhookAttemptDTO {
  return {
    id: row.id,
    webhookId: row.webhookId,
    receivedAt: row.receivedAt.toISOString(),
    // The column is a free-form `String` in Postgres, so a corrupted or hand-inserted
    // row must fail loudly here instead of silently flowing through as an outcome the
    // rest of the codebase (and the API's callers) never expected to see.
    outcome: WebhookOutcome.parse(row.outcome),
    statusCode: row.statusCode,
    eventName: row.eventName,
    preview: row.preview,
    deliveryId: row.deliveryId,
    runId: row.runId,
    reason: row.reason,
  };
}

function previewOf(payload: unknown): string | null {
  let text: string;
  if (typeof payload === "string") {
    text = payload;
  } else {
    try {
      text = JSON.stringify(payload) ?? "";
    } catch {
      return null;
    }
  }
  if (!text) return null;
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** `WebhookDelivery.externalId` is required even when the caller sends no idempotency
 * key; a synthetic id keyed on the run never collides, so only real delivery ids dedupe. */
function externalIdFor(deliveryId: string | null | undefined, runId: string): string {
  return deliveryId ?? `auto:${runId}`;
}

/** Minimum number of full-transaction attempts for `receive()` under contention. Each
 * retry re-enters from the top: reload the webhook, re-check the secret, re-read the
 * dedupe/rate-limit/nonterminal state. Nothing here is allowed to "recover" a losing
 * transaction by skipping authentication. */
const WEBHOOK_RECEIVE_MAX_ATTEMPTS = 5;

/** Prisma P2002 on `webhook_deliveries(webhookId, externalId)`, or P2034 when the
 * serializable isolation level aborts a losing transaction outright. Either means a
 * concurrent request for the same delivery id (or the same nonterminal-run/rate-limit
 * count) raced this one and must be retried from scratch. */
function isRetryableTransactionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: string; meta?: { modelName?: string; target?: unknown } };
  if (candidate.code === "P2034") return true;
  if (candidate.code !== "P2002") return false;
  const target = Array.isArray(candidate.meta?.target)
    ? (candidate.meta?.target as string[])
    : typeof candidate.meta?.target === "string"
      ? [candidate.meta.target]
      : [];
  return candidate.meta?.modelName === "WebhookDelivery" || target.includes("externalId");
}

/** Retries the whole `receive()` transaction body on a serialization conflict (P2034) or
 * a losing unique-delivery insert (P2002). Every retry re-enters `fn` from the top, so it
 * reloads the webhook and re-checks the secret; it never reuses state from the losing
 * attempt and never trusts a result computed outside a fresh, authenticated transaction. */
async function withTransactionRetries<T>(fn: () => Promise<T>, maxAttempts: number): Promise<T> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableTransactionError(error)) throw error;
    }
  }
}

async function recordAttempt(
  tx: Prisma.TransactionClient | PrismaClient,
  input: {
    webhookId: string;
    outcome: WebhookReceiveOutcome;
    statusCode: number;
    receivedAt: Date;
    eventName?: string | null;
    deliveryId?: string | null;
    runId?: string | null;
    reason?: string;
    preview?: string | null;
  },
) {
  await tx.webhookAttempt.create({
    data: {
      webhookId: input.webhookId,
      receivedAt: input.receivedAt,
      outcome: input.outcome,
      statusCode: input.statusCode,
      eventName: input.eventName ?? null,
      deliveryId: input.deliveryId ?? null,
      runId: input.runId ?? null,
      reason: input.reason ?? null,
      preview: input.preview ?? null,
    },
  });
}

interface DeliveryContext {
  webhook: WebhookRow;
  event: WebhookReceiveEvent;
  deliveryId: string | null;
  receivedAt: Date;
}

/**
 * The shared transactional core behind both `receive()` (secret-authenticated) and
 * `testRun()` (actor-authenticated): dedupe, pause/rate-limit/nonterminal-cap checks,
 * event-type filtering, and `Task`/`Run`/`WebhookDelivery` creation via `buildPrompt`.
 * Callers are responsible for authenticating before invoking this and for loading
 * `ctx.webhook` fresh inside the same transaction attempt.
 */
async function processDelivery(
  tx: Prisma.TransactionClient,
  buildPrompt: WebhookServiceDeps["buildPrompt"],
  ctx: DeliveryContext,
): Promise<WebhookReceiveResult> {
  const { webhook, event, deliveryId, receivedAt } = ctx;

  if (deliveryId) {
    const existingDelivery = await tx.webhookDelivery.findUnique({
      where: { webhookId_externalId: { webhookId: webhook.id, externalId: deliveryId } },
    });
    if (existingDelivery) {
      const existingRun = await tx.run.findUnique({
        where: { id: existingDelivery.runId },
        select: { taskId: true },
      });
      await recordAttempt(tx, {
        webhookId: webhook.id,
        outcome: "duplicate",
        statusCode: 202,
        receivedAt,
        eventName: event.eventName,
        deliveryId,
        runId: existingDelivery.runId,
      });
      return {
        outcome: "duplicate",
        duplicate: true,
        statusCode: 202,
        runId: existingDelivery.runId,
        taskId: existingRun?.taskId ?? null,
      } satisfies WebhookReceiveResult;
    }
  }

  if (!webhook.active) {
    await recordAttempt(tx, {
      webhookId: webhook.id,
      outcome: "rejected",
      statusCode: 409,
      receivedAt,
      eventName: event.eventName,
      deliveryId,
      reason: "paused",
    });
    return {
      outcome: "rejected",
      duplicate: false,
      statusCode: 409,
      runId: null,
      taskId: null,
      reason: "paused",
    } satisfies WebhookReceiveResult;
  }

  // Only newly accepted deliveries consume the authenticated rate limit: an invalid
  // secret never got past authentication, and a duplicate delivery id did not create a
  // new receipt, so neither should count against the caller that is actually delivering
  // distinct, authenticated events.
  const windowStart = new Date(receivedAt.getTime() - WEBHOOK_RATE_LIMIT_WINDOW_MS);
  const recentDeliveries = await tx.webhookDelivery.count({
    where: { webhookId: webhook.id, receivedAt: { gte: windowStart } },
  });
  if (recentDeliveries >= WEBHOOK_RATE_LIMIT_PER_MINUTE) {
    await recordAttempt(tx, {
      webhookId: webhook.id,
      outcome: "rejected",
      statusCode: 429,
      receivedAt,
      eventName: event.eventName,
      deliveryId,
      reason: "rate_limited",
    });
    return {
      outcome: "rejected",
      duplicate: false,
      statusCode: 429,
      runId: null,
      taskId: null,
      reason: "rate_limited",
    } satisfies WebhookReceiveResult;
  }

  const nonterminalCount = await tx.run.count({
    where: { webhookId: webhook.id, status: { in: NONTERMINAL_RUN_STATUSES } },
  });
  if (nonterminalCount >= WEBHOOK_MAX_NONTERMINAL_RUNS) {
    await recordAttempt(tx, {
      webhookId: webhook.id,
      outcome: "rejected",
      statusCode: 429,
      receivedAt,
      eventName: event.eventName,
      deliveryId,
      reason: "too_many_runs",
    });
    return {
      outcome: "rejected",
      duplicate: false,
      statusCode: 429,
      runId: null,
      taskId: null,
      reason: "too_many_runs",
    } satisfies WebhookReceiveResult;
  }

  const eventTypes = webhook.eventTypes;
  const eventAllowed =
    eventTypes.length === 0 || (event.eventName != null && eventTypes.includes(event.eventName));
  if (!eventAllowed) {
    await recordAttempt(tx, {
      webhookId: webhook.id,
      outcome: "ignored",
      statusCode: 202,
      receivedAt,
      eventName: event.eventName,
      deliveryId,
      reason: "event_type_filtered",
    });
    return {
      outcome: "ignored",
      duplicate: false,
      statusCode: 202,
      runId: null,
      taskId: null,
      reason: "event_type_filtered",
    } satisfies WebhookReceiveResult;
  }

  const bot = await tx.bot.findUnique({
    where: { id: webhook.botId },
    include: { thread: true },
  });
  if (!bot?.thread) {
    await recordAttempt(tx, {
      webhookId: webhook.id,
      outcome: "rejected",
      statusCode: 410,
      receivedAt,
      eventName: event.eventName,
      deliveryId,
      reason: "bot_missing_thread",
    });
    return {
      outcome: "rejected",
      duplicate: false,
      statusCode: 410,
      runId: null,
      taskId: null,
      reason: "bot_missing_thread",
    } satisfies WebhookReceiveResult;
  }

  // Only now, fully authenticated and past every filter, is it safe to turn the raw
  // payload into model input.
  const prompt = buildPrompt({
    webhook: mapWebhook(webhook),
    event,
    receivedAt,
    deliveryId,
  });

  const task = await tx.task.create({
    data: {
      workspaceId: webhook.workspaceId,
      botId: webhook.botId,
      threadId: bot.thread.id,
      userId: webhook.userId,
      prompt,
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      workspaceId: webhook.workspaceId,
      botId: webhook.botId,
      threadId: bot.thread.id,
      taskId: task.id,
      userId: webhook.userId,
      status: "queued",
      trigger: "webhook",
      webhookId: webhook.id,
    },
  });
  await tx.webhookDelivery.create({
    data: {
      webhookId: webhook.id,
      externalId: externalIdFor(deliveryId, run.id),
      runId: run.id,
      receivedAt,
    },
  });
  await recordAttempt(tx, {
    webhookId: webhook.id,
    outcome: "accepted",
    statusCode: 202,
    receivedAt,
    eventName: event.eventName,
    deliveryId,
    runId: run.id,
    preview: previewOf(event.payload),
  });
  await tx.webhook.update({
    where: { id: webhook.id },
    data: {
      deliveryCount: { increment: 1 },
      lastReceivedAt: receivedAt,
      lastRunId: run.id,
    },
  });

  return {
    outcome: "accepted",
    duplicate: false,
    statusCode: 202,
    runId: run.id,
    taskId: task.id,
  } satisfies WebhookReceiveResult;
}

/**
 * After a `receive()`/`testRun()` transaction commits, enqueues `run.continue` for a
 * freshly accepted run, or re-enqueues a duplicate's run if it is still `queued` (for
 * example because an earlier enqueue attempt failed). A wakeup failure here is captured,
 * not thrown: the delivery already committed, so it must still be reported as accepted.
 */
async function enqueueAfterCommit(
  prisma: PrismaClient,
  wakeup: WebhookWakeup,
  result: WebhookReceiveResult,
): Promise<void> {
  if (!result.runId) return;
  let shouldEnqueue = result.outcome === "accepted";
  if (!shouldEnqueue && result.outcome === "duplicate") {
    const run = await prisma.run.findUnique({
      where: { id: result.runId },
      select: { status: true },
    });
    shouldEnqueue = run?.status === "queued";
  }
  if (!shouldEnqueue) return;
  try {
    await wakeup.enqueue({
      name: "run.continue",
      payload: { runId: result.runId },
      jobKey: `run.continue:${result.runId}`,
    });
  } catch (error) {
    // The delivery already committed, so a wakeup failure must not turn an accepted
    // receipt into an error; the run stays queued for a future retry (or the reaper) to
    // pick up and enqueue again. Still log it so a stuck queue is diagnosable.
    console.error("webhook run.continue enqueue", error);
  }
}

async function cancelQueuedRuns(
  tx: Prisma.TransactionClient,
  webhookId: string,
  now: Date,
): Promise<void> {
  const queued = await tx.run.findMany({
    where: { webhookId, status: "queued" },
    select: { id: true, taskId: true },
  });
  if (queued.length === 0) return;
  const runIds = queued.map((run) => run.id);
  const taskIds = queued.map((run) => run.taskId);
  await tx.run.updateMany({
    where: { id: { in: runIds } },
    data: { status: "cancelled", completedAt: now },
  });
  await tx.task.updateMany({
    where: { id: { in: taskIds } },
    data: { status: "cancelled" },
  });
}

/**
 * Deletion of the webhook, unlike pausing, must not leave any mid-flight run behind: the
 * FK is `onDelete: SetNull`, so a run the delete didn't cancel first would keep running
 * (or waiting for a card) with `webhookId` wiped out — silently downgraded from unattended
 * to attended, since the executor's gate is `trigger === "webhook" || Boolean(webhookId)`.
 * This walks every non-terminal run carrying this webhook's id, including peer/spawn
 * descendants that inherited it, and cancels the run, its running Attempt, and its Task.
 */
async function cancelAllNonTerminalRuns(
  tx: Prisma.TransactionClient,
  webhookId: string,
  now: Date,
): Promise<void> {
  const nonTerminal = await tx.run.findMany({
    where: { webhookId, status: { in: NONTERMINAL_RUN_STATUSES } },
    select: { id: true, taskId: true },
  });
  if (nonTerminal.length === 0) return;
  const runIds = nonTerminal.map((run) => run.id);
  const taskIds = nonTerminal.map((run) => run.taskId);
  await tx.run.updateMany({
    where: { id: { in: runIds } },
    data: { status: "cancelled", completedAt: now, leaseOwner: null, leaseExpiresAt: null },
  });
  await tx.attempt.updateMany({
    where: { runId: { in: runIds }, status: "running" },
    data: { status: "cancelled", finishedAt: now },
  });
  await tx.task.updateMany({
    where: { id: { in: taskIds } },
    data: { status: "cancelled" },
  });
}

export type WebhookService = ReturnType<typeof createWebhookService>;

export function createWebhookService(deps: WebhookServiceDeps) {
  const { prisma } = deps;
  const now = deps.now ?? (() => new Date());

  async function getOwnedWebhook(actor: Actor, webhookId: string) {
    const webhook = await prisma.webhook.findFirst({
      where: { id: webhookId, workspaceId: actor.workspaceId, userId: actor.userId },
    });
    if (!webhook) throw new IsolationError();
    return webhook;
  }

  return {
    async list(actor: Actor, input: { botId: string }): Promise<WebhookDTO[]> {
      const bot = await prisma.bot.findFirst({
        where: { id: input.botId, workspaceId: actor.workspaceId, userId: actor.userId },
      });
      if (!bot) throw new IsolationError();
      const rows = await prisma.webhook.findMany({
        where: { botId: input.botId, workspaceId: actor.workspaceId, userId: actor.userId },
        orderBy: { createdAt: "desc" },
      });
      return rows.map(mapWebhook);
    },

    async create(
      actor: Actor,
      input: CreateWebhookServiceInput,
    ): Promise<{ webhook: WebhookDTO; secret: string }> {
      const bot = await prisma.bot.findFirst({
        where: { id: input.botId, workspaceId: actor.workspaceId, userId: actor.userId },
      });
      if (!bot) throw new IsolationError();
      const secret = generateWebhookSecret();
      const created = await prisma.webhook.create({
        data: {
          endpointId: generateWebhookEndpointId(),
          workspaceId: actor.workspaceId,
          userId: actor.userId,
          botId: input.botId,
          name: input.name,
          prompt: input.prompt ?? "",
          active: input.active ?? true,
          eventTypes: input.eventTypes ?? [],
          secretHash: hashWebhookSecret(secret),
        },
      });
      return { webhook: mapWebhook(created), secret };
    },

    async update(actor: Actor, input: UpdateWebhookServiceInput): Promise<WebhookDTO> {
      const existing = await getOwnedWebhook(actor, input.webhookId);
      const pausing = input.active === false && existing.active !== false;
      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.webhook.update({
          where: { id: existing.id },
          data: {
            name: input.name,
            prompt: input.prompt,
            active: input.active,
            eventTypes: input.eventTypes,
          },
        });
        if (pausing) await cancelQueuedRuns(tx, existing.id, now());
        return row;
      });
      return mapWebhook(updated);
    },

    async remove(actor: Actor, input: { webhookId: string }): Promise<void> {
      const existing = await getOwnedWebhook(actor, input.webhookId);
      await prisma.$transaction(async (tx) => {
        await cancelAllNonTerminalRuns(tx, existing.id, now());
        await tx.webhook.delete({ where: { id: existing.id } });
      });
    },

    async rotateSecret(
      actor: Actor,
      input: { webhookId: string },
    ): Promise<{ webhook: WebhookDTO; secret: string }> {
      const existing = await getOwnedWebhook(actor, input.webhookId);
      const secret = generateWebhookSecret();
      const updated = await prisma.webhook.update({
        where: { id: existing.id },
        data: { secretHash: hashWebhookSecret(secret) },
      });
      return { webhook: mapWebhook(updated), secret };
    },

    async attempts(
      actor: Actor,
      input: { webhookId: string; limit?: number },
    ): Promise<WebhookAttemptDTO[]> {
      const existing = await getOwnedWebhook(actor, input.webhookId);
      const take = Math.min(
        WEBHOOK_ATTEMPTS_MAX_LIMIT,
        Math.max(WEBHOOK_ATTEMPTS_MIN_LIMIT, input.limit ?? WEBHOOK_ATTEMPTS_DEFAULT_LIMIT),
      );
      const rows = await prisma.webhookAttempt.findMany({
        where: { webhookId: existing.id },
        orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
        take,
      });
      return rows.map(mapAttempt);
    },

    /**
     * Lets a caller (Task 4's HTTP handler) authenticate before reading the request body,
     * without duplicating the secret comparison outside this service. Returns `false` for
     * both an unknown endpoint and a wrong secret on a known one — the boundary never
     * reveals which case applied. `receive()` re-authenticates independently, so a secret
     * rotated between this call and the body read is still enforced correctly.
     */
    async authorize(
      endpointId: string,
      secret: string,
      metadata?: WebhookAuthorizeMetadata,
    ): Promise<boolean> {
      const webhook = await prisma.webhook.findUnique({ where: { endpointId } });
      if (!webhook) return false;
      if (webhookSecretMatches(secret, webhook.secretHash)) return true;
      await recordAttempt(prisma, {
        webhookId: webhook.id,
        outcome: "rejected",
        statusCode: 401,
        receivedAt: now(),
        eventName: metadata?.eventName,
        deliveryId: metadata?.deliveryId,
        reason: "invalid_secret",
      });
      return false;
    },

    /**
     * Records a rejected attempt for a known endpoint when the API layer refuses a
     * request *after* authorization succeeded but before `receive()` could run — an
     * oversized body, malformed JSON, or a body read failure. Never writes Prisma
     * directly from a route: this is the one place an HTTP handler goes through. A
     * webhook that no longer exists (deleted mid-request) is a silent no-op, not a
     * throw, since the caller already committed to answering the HTTP request either way.
     */
    async recordRejected(
      endpointId: string,
      statusCode: number,
      reason: string,
      metadata?: WebhookAuthorizeMetadata & { preview?: string | null },
    ): Promise<void> {
      const webhook = await prisma.webhook.findUnique({ where: { endpointId } });
      if (!webhook) return;
      await recordAttempt(prisma, {
        webhookId: webhook.id,
        outcome: "rejected",
        statusCode,
        receivedAt: now(),
        eventName: metadata?.eventName,
        deliveryId: metadata?.deliveryId,
        reason,
        preview: metadata?.preview,
      });
    },

    async receive(input: WebhookReceiveInput): Promise<WebhookReceiveResult> {
      const receivedAt = now();
      const result = await withTransactionRetries(
        () =>
          prisma.$transaction(
            async (tx) => {
              const webhook = await tx.webhook.findUnique({
                where: { endpointId: input.endpointId },
              });
              if (!webhook) throw new WebhookNotFoundError();

              // Authentication is the boundary: nothing below this line may read
              // `input.event.payload` before the secret is confirmed to match.
              if (!webhookSecretMatches(input.secret, webhook.secretHash)) {
                await recordAttempt(tx, {
                  webhookId: webhook.id,
                  outcome: "rejected",
                  statusCode: 401,
                  receivedAt,
                  eventName: input.event.eventName,
                  deliveryId: input.event.deliveryId,
                  reason: "invalid_secret",
                });
                return {
                  outcome: "rejected",
                  duplicate: false,
                  statusCode: 401,
                  runId: null,
                  taskId: null,
                  reason: "invalid_secret",
                } satisfies WebhookReceiveResult;
              }

              return processDelivery(tx, deps.buildPrompt, {
                webhook,
                event: input.event,
                deliveryId: input.event.deliveryId ?? null,
                receivedAt,
              });
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
        WEBHOOK_RECEIVE_MAX_ATTEMPTS,
      );

      await enqueueAfterCommit(prisma, deps.wakeup, result);
      return result;
    },

    /**
     * Lets an owner trigger a bot the same way a real delivery would, for manual testing
     * from the UI. Authorization is actor-based (via `getOwnedWebhook`) instead of
     * secret-based, but creation goes through the exact same transactional core — dedupe,
     * pause/rate-limit/nonterminal-cap checks, event-type filtering, and `buildPrompt` —
     * as `receive()`. A synthetic, unique delivery id means repeated test runs never
     * dedupe against each other or against a real delivery.
     */
    async testRun(
      actor: Actor,
      webhookId: string,
      event?: WebhookTestRunEvent,
    ): Promise<WebhookReceiveResult> {
      const owned = await getOwnedWebhook(actor, webhookId);
      const receivedAt = now();
      const deliveryId = `test:${randomBytes(9).toString("base64url")}`;
      const testEvent: WebhookReceiveEvent = {
        payload: event?.payload ?? { event: "quibt.test", task: "Teste de webhook" },
        eventName: event?.eventName ?? owned.eventTypes[0] ?? null,
        deliveryId,
      };

      const result = await withTransactionRetries(
        () =>
          prisma.$transaction(
            async (tx) => {
              const webhook = await tx.webhook.findUnique({ where: { id: owned.id } });
              if (!webhook) throw new WebhookNotFoundError();
              return processDelivery(tx, deps.buildPrompt, {
                webhook,
                event: testEvent,
                deliveryId,
                receivedAt,
              });
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
        WEBHOOK_RECEIVE_MAX_ATTEMPTS,
      );

      await enqueueAfterCommit(prisma, deps.wakeup, result);
      return result;
    },
  };
}
