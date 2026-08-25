import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Actor } from "@quibt/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "./client.js";
import { createPeerWake } from "./collaboration.js";
import { IsolationError } from "./scope.js";
import { createWebhookService, WebhookNotFoundError, type WebhookWakeup } from "./webhooks.js";

function loadDatabaseUrl() {
  const file = path.resolve(".env");
  if (!existsSync(file) || process.env.DATABASE_URL) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq);
    if (key !== "DATABASE_URL") continue;
    process.env.DATABASE_URL = trimmed.slice(eq + 1);
    return;
  }
}

loadDatabaseUrl();

const hasDb = Boolean(process.env.DATABASE_URL);
const describeWebhooks = hasDb ? describe : describe.skip;

/**
 * The receive() transaction authenticates, deduplicates and enqueues against real
 * Postgres constraints (the serializable isolation level and the unique delivery
 * index), so a hand-written Prisma fake would not prove anything about the race it
 * exists to close.
 */
describeWebhooks("createWebhookService against Postgres", () => {
  let db: ReturnType<typeof createDb>;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
  });

  let workspaceCounter = 0;

  async function newWorkspace() {
    workspaceCounter += 1;
    const workspaceId = `ws-wh-${stamp}-${workspaceCounter}`;
    const userId = `user-wh-${stamp}-${workspaceCounter}`;
    await db.prisma.organization.create({
      data: {
        id: workspaceId,
        name: "Webhook workspace",
        slug: `wh-${stamp}-${workspaceCounter}`,
        createdAt: new Date(),
      },
    });
    const actor: Actor = {
      userId,
      workspaceId,
      workspaceRole: "owner",
      email: `${userId}@example.com`,
      isDeploymentOwner: false,
    };
    const bot = await db.prisma.bot.create({
      data: { workspaceId, userId, name: "Webhook bot", color: "#123456" },
    });
    await db.prisma.thread.create({ data: { workspaceId, userId, botId: bot.id } });
    return { actor, botId: bot.id, workspaceId, userId };
  }

  function harness(options?: { now?: () => Date }) {
    const jobs: Array<{ name: string; payload: Record<string, unknown>; jobKey?: string }> = [];
    const wakeup: WebhookWakeup = {
      enqueue: async (job) => void jobs.push(job),
    };
    const prompts: unknown[] = [];
    const service = createWebhookService({
      prisma: db.prisma,
      wakeup,
      now: options?.now,
      buildPrompt: (input) => {
        prompts.push(input);
        return `prompt:${JSON.stringify(input.event.payload)}`;
      },
    });
    return { service, jobs, prompts };
  }

  it("accepts a first delivery, enqueues run.continue, and treats a retried delivery id as a duplicate without a second run", async () => {
    const { actor, botId } = await newWorkspace();
    const { service, jobs } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });

    const first = await service.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "Revise o build" }, deliveryId: "evt-1" },
    });
    const retry = await service.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "Revise o build" }, deliveryId: "evt-1" },
    });

    expect(first.duplicate).toBe(false);
    expect(first.outcome).toBe("accepted");
    expect(first.runId).not.toBeNull();
    expect(retry).toMatchObject({ duplicate: true, runId: first.runId, outcome: "duplicate" });
    expect(await db.prisma.run.count({ where: { webhookId: created.webhook.id } })).toBe(1);
    // The run is still `queued` when the retry lands, so the duplicate branch enqueues it
    // again too (harmless: `run.continue` is idempotent on an unclaimed queued run) —
    // this is what makes a failed first enqueue recoverable via retry.
    expect(jobs).toEqual([
      {
        name: "run.continue",
        payload: { runId: first.runId },
        jobKey: `run.continue:${first.runId}`,
      },
      {
        name: "run.continue",
        payload: { runId: first.runId },
        jobKey: `run.continue:${first.runId}`,
      },
    ]);

    const attempts = await service.attempts(actor, { webhookId: created.webhook.id });
    expect(attempts.map((attempt) => attempt.outcome)).toEqual(["duplicate", "accepted"]);
  });

  it("sends a jobKey derived from the run id on every enqueue/re-enqueue so a real driver can dedupe retries", async () => {
    const { actor, botId } = await newWorkspace();
    const { service, jobs } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });

    const first = await service.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "x" }, deliveryId: "evt-jobkey" },
    });
    // The duplicate retry re-enqueues the same still-queued run, so both the original
    // enqueue and the re-enqueue must carry the same jobKey for the run.
    await service.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "x" }, deliveryId: "evt-jobkey" },
    });

    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.jobKey).toBe(`run.continue:${first.runId}`);
    }
  });

  it("enqueues run.continue only after the transaction commits", async () => {
    const { actor, botId } = await newWorkspace();
    const { service } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });

    // Queried *inside* the enqueue callback itself, on the same non-transactional client:
    // if the row is visible there, the transaction that wrote it already committed.
    let deliveryVisibleDuringEnqueue: unknown = "not checked";
    const observed = createWebhookService({
      prisma: db.prisma,
      wakeup: {
        enqueue: async (job) => {
          deliveryVisibleDuringEnqueue = await db.prisma.webhookDelivery.findUnique({
            where: {
              webhookId_externalId: { webhookId: created.webhook.id, externalId: "evt-commit" },
            },
          });
          void job;
        },
      },
      buildPrompt: () => "prompt",
    });
    await observed.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "x" }, deliveryId: "evt-commit" },
    });

    expect(deliveryVisibleDuringEnqueue).not.toBe("not checked");
    expect(deliveryVisibleDuringEnqueue).not.toBeNull();
  });

  it("captures a wakeup.enqueue failure after commit and still reports the delivery as accepted", async () => {
    const { actor, botId } = await newWorkspace();
    const { service: createService } = harness();
    const created = await createService.create(actor, { botId, name: "Builds", prompt: "" });

    const failingJobs: Array<{ name: string; payload: Record<string, unknown> }> = [];
    let enqueueCalls = 0;
    const failingService = createWebhookService({
      prisma: db.prisma,
      wakeup: {
        enqueue: async (job) => {
          enqueueCalls += 1;
          if (enqueueCalls === 1) throw new Error("wakeup unavailable");
          failingJobs.push(job);
        },
      },
      buildPrompt: () => "prompt",
    });

    const first = await failingService.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "x" }, deliveryId: "evt-enqueue-fail" },
    });
    expect(first.outcome).toBe("accepted");
    expect(first.runId).not.toBeNull();
    const runAfterFailedEnqueue = await db.prisma.run.findUniqueOrThrow({
      where: { id: first.runId! },
    });
    expect(runAfterFailedEnqueue.status).toBe("queued");

    // A retry of the same delivery id finds the run still queued and re-enqueues it,
    // without creating a second Task/Run.
    const retry = await failingService.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "x" }, deliveryId: "evt-enqueue-fail" },
    });
    expect(retry).toMatchObject({ outcome: "duplicate", runId: first.runId });
    expect(failingJobs).toEqual([
      {
        name: "run.continue",
        payload: { runId: first.runId },
        jobKey: `run.continue:${first.runId}`,
      },
    ]);
    expect(await db.prisma.run.count({ where: { webhookId: created.webhook.id } })).toBe(1);
    expect(await db.prisma.task.count({ where: { botId } })).toBe(1);
  });

  it("logs a stable message to console.error when wakeup.enqueue fails after commit, without throwing", async () => {
    const { actor, botId } = await newWorkspace();
    const { service: createService } = harness();
    const created = await createService.create(actor, { botId, name: "Builds", prompt: "" });

    const enqueueError = new Error("wakeup unavailable");
    const failingService = createWebhookService({
      prisma: db.prisma,
      wakeup: {
        enqueue: async () => {
          throw enqueueError;
        },
      },
      buildPrompt: () => "prompt",
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await failingService.receive({
        endpointId: created.webhook.endpointId,
        secret: created.secret,
        event: { payload: { task: "x" }, deliveryId: "evt-enqueue-log" },
      });
      expect(result.outcome).toBe("accepted");
      expect(errorSpy).toHaveBeenCalledWith("webhook run.continue enqueue", enqueueError);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not re-enqueue a duplicate once the original run has already left the queue", async () => {
    const { actor, botId } = await newWorkspace();
    const { service, jobs } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });

    const first = await service.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "x" }, deliveryId: "evt-left-queue" },
    });
    expect(first.outcome).toBe("accepted");
    await db.prisma.run.update({ where: { id: first.runId! }, data: { status: "running" } });

    const duplicate = await service.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "x" }, deliveryId: "evt-left-queue" },
    });
    expect(duplicate.outcome).toBe("duplicate");
    // Only the original accepted delivery enqueued; the duplicate did not enqueue a run
    // that already moved past `queued`.
    expect(jobs).toHaveLength(1);
  });

  it("rejects an invalid secret before building the prompt and records a rejected attempt", async () => {
    const { actor, botId } = await newWorkspace();
    const { service, prompts } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });

    const result = await service.receive({
      endpointId: created.webhook.endpointId,
      secret: "whsec_wrong",
      event: { payload: { task: "não deveria processar" } },
    });

    expect(result).toMatchObject({ outcome: "rejected", duplicate: false, runId: null });
    expect(result.statusCode).toBe(401);
    expect(prompts).toHaveLength(0);
    const attempts = await service.attempts(actor, { webhookId: created.webhook.id });
    expect(attempts[0]).toMatchObject({ outcome: "rejected", statusCode: 401 });
    expect(await db.prisma.run.count({ where: { webhookId: created.webhook.id } })).toBe(0);
  });

  it("rejects an unknown endpoint id", async () => {
    const { service } = harness();
    await expect(
      service.receive({
        endpointId: "wh_does_not_exist",
        secret: "whsec_anything",
        event: { payload: {} },
      }),
    ).rejects.toThrow(WebhookNotFoundError);
  });

  it("isolates list/CRUD by actor and workspace", async () => {
    const { actor, botId } = await newWorkspace();
    const other = await newWorkspace();
    const { service } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });

    expect(await service.list(other.actor, { botId: other.botId })).toEqual([]);
    await expect(service.list(other.actor, { botId })).rejects.toThrow(IsolationError);
    await expect(
      service.update(other.actor, { webhookId: created.webhook.id, name: "Roubado" }),
    ).rejects.toThrow(IsolationError);
    await expect(service.remove(other.actor, { webhookId: created.webhook.id })).rejects.toThrow(
      IsolationError,
    );
    await expect(
      service.rotateSecret(other.actor, { webhookId: created.webhook.id }),
    ).rejects.toThrow(IsolationError);
    await expect(service.attempts(other.actor, { webhookId: created.webhook.id })).rejects.toThrow(
      IsolationError,
    );

    const owned = await service.list(actor, { botId });
    expect(owned.map((webhook) => webhook.id)).toEqual([created.webhook.id]);
  });

  it("rotates the secret so the old secret is rejected and the new one authenticates", async () => {
    const { actor, botId } = await newWorkspace();
    const { service } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });
    const oldSecret = created.secret;

    const rotated = await service.rotateSecret(actor, { webhookId: created.webhook.id });
    expect(rotated.secret).not.toBe(oldSecret);
    expect(rotated.webhook.endpointId).toBe(created.webhook.endpointId);

    const withOldSecret = await service.receive({
      endpointId: created.webhook.endpointId,
      secret: oldSecret,
      event: { payload: {} },
    });
    expect(withOldSecret.outcome).toBe("rejected");

    const withNewSecret = await service.receive({
      endpointId: created.webhook.endpointId,
      secret: rotated.secret,
      event: { payload: { task: "ok" } },
    });
    expect(withNewSecret.outcome).toBe("accepted");
  });

  it("pausing cancels queued runs but leaves the webhook rejecting new deliveries", async () => {
    const { actor, botId } = await newWorkspace();
    const { service } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });
    const receipt = await service.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "fica na fila" }, deliveryId: "evt-queued" },
    });
    expect(receipt.outcome).toBe("accepted");

    await service.update(actor, { webhookId: created.webhook.id, active: false });

    const run = await db.prisma.run.findUniqueOrThrow({ where: { id: receipt.runId! } });
    expect(run.status).toBe("cancelled");
    const task = await db.prisma.task.findUniqueOrThrow({ where: { id: run.taskId } });
    expect(task.status).toBe("cancelled");

    const rejected = await service.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "bloqueado" }, deliveryId: "evt-paused" },
    });
    expect(rejected).toMatchObject({ outcome: "rejected", runId: null, statusCode: 409 });
  });

  it("pausing also cancels a queued peer/spawn descendant that inherited the same webhookId", async () => {
    const { actor, botId, workspaceId, userId } = await newWorkspace();
    const { service } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });
    const receipt = await service.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "fica na fila" }, deliveryId: "evt-descendant" },
    });
    expect(receipt.outcome).toBe("accepted");

    // Simulate what the executor's ask_bot/message_teammate/spawn_bot tools do: a descendant
    // run keeps its own ordinary "peer" trigger, but carries the same causal webhookId.
    const teammate = await db.prisma.bot.create({
      data: { workspaceId, userId, name: "Peer teammate", color: "#654321" },
    });
    await db.prisma.thread.create({ data: { workspaceId, userId, botId: teammate.id } });
    const peer = await createPeerWake(db.prisma, actor, {
      fromBotId: botId,
      toBotId: teammate.id,
      text: "pode revisar isso?",
      webhookId: created.webhook.id,
    });
    expect(peer.run.trigger).toBe("peer");
    expect(peer.run.webhookId).toBe(created.webhook.id);
    expect((await db.prisma.run.findUniqueOrThrow({ where: { id: peer.run.id } })).status).toBe(
      "queued",
    );

    await service.update(actor, { webhookId: created.webhook.id, active: false });

    const originalRun = await db.prisma.run.findUniqueOrThrow({ where: { id: receipt.runId! } });
    expect(originalRun.status).toBe("cancelled");
    const peerRun = await db.prisma.run.findUniqueOrThrow({ where: { id: peer.run.id } });
    expect(peerRun.status).toBe("cancelled");
    const peerTask = await db.prisma.task.findUniqueOrThrow({ where: { id: peerRun.taskId } });
    expect(peerTask.status).toBe("cancelled");
  });

  it("returns 410 and records an attempt when the webhook's bot has no thread", async () => {
    const { actor, workspaceId, userId } = await newWorkspace();
    const bot = await db.prisma.bot.create({
      data: { workspaceId, userId, name: "Bot sem thread", color: "#654321" },
    });
    const { service } = harness();
    const created = await service.create(actor, { botId: bot.id, name: "Builds", prompt: "" });

    const result = await service.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "sem thread" }, deliveryId: "evt-no-thread" },
    });

    expect(result).toMatchObject({ outcome: "rejected", statusCode: 410, runId: null });
    const attempts = await service.attempts(actor, { webhookId: created.webhook.id });
    expect(attempts[0]).toMatchObject({ outcome: "rejected", statusCode: 410 });
  });

  it("cancels a run that already left the queue too when the webhook is deleted — deleting must not silently downgrade a mid-flight run to attended", async () => {
    const { actor, botId } = await newWorkspace();
    const { service } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });
    const queued = await service.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "fila" }, deliveryId: "evt-a" },
    });
    const running = await service.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "rodando" }, deliveryId: "evt-b" },
    });
    await db.prisma.run.update({ where: { id: running.runId! }, data: { status: "running" } });
    await db.prisma.attempt.create({
      data: { runId: running.runId!, fence: 0, status: "running" },
    });

    await service.remove(actor, { webhookId: created.webhook.id });

    expect((await db.prisma.run.findUniqueOrThrow({ where: { id: queued.runId! } })).status).toBe(
      "cancelled",
    );
    // The FK is onDelete: SetNull, so `webhookId` goes to null regardless — the point of this
    // hardening is that the run is no longer *running unattended with no origin to gate it*:
    // it is terminal (cancelled) by the time the delete commits, not left in-flight.
    const runningAfter = await db.prisma.run.findUniqueOrThrow({ where: { id: running.runId! } });
    expect(runningAfter.status).toBe("cancelled");
    expect(runningAfter.webhookId).toBeNull();
    expect(runningAfter.leaseOwner).toBeNull();
    expect(runningAfter.leaseExpiresAt).toBeNull();
    const runningTask = await db.prisma.task.findUniqueOrThrow({
      where: { id: runningAfter.taskId },
    });
    expect(runningTask.status).toBe("cancelled");
    const runningAttempt = await db.prisma.attempt.findFirstOrThrow({
      where: { runId: running.runId! },
    });
    expect(runningAttempt.status).toBe("cancelled");
    expect(runningAttempt.finishedAt).not.toBeNull();
    // The webhook itself is gone.
    expect(await db.prisma.webhook.findUnique({ where: { id: created.webhook.id } })).toBeNull();
  });

  it("cancels a peer descendant (own trigger, inherited webhookId) too when the webhook is deleted, even mid-turn (waiting_input) or running", async () => {
    const { actor, botId, workspaceId, userId } = await newWorkspace();
    const { service } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });
    const receipt = await service.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "origem" }, deliveryId: "evt-delete-descendant" },
    });
    expect(receipt.outcome).toBe("accepted");

    const teammate = await db.prisma.bot.create({
      data: { workspaceId, userId, name: "Peer teammate", color: "#654321" },
    });
    await db.prisma.thread.create({ data: { workspaceId, userId, botId: teammate.id } });
    // Same shape the executor's ask_bot/message_teammate produce: an ordinary "peer" trigger
    // that inherited the origin webhook's id.
    const peer = await createPeerWake(db.prisma, actor, {
      fromBotId: botId,
      toBotId: teammate.id,
      text: "pode revisar isso?",
      webhookId: created.webhook.id,
    });
    expect(peer.run.trigger).toBe("peer");
    // Parked waiting for a card/answer mid-turn — exactly the state a naive "cancel only
    // queued" delete would leave behind, silently attended once the FK nulls webhookId.
    await db.prisma.run.update({
      where: { id: peer.run.id },
      data: { status: "waiting_input", leaseOwner: "worker-1", leaseExpiresAt: new Date() },
    });
    await db.prisma.attempt.create({
      data: { runId: peer.run.id, fence: 0, status: "running" },
    });

    await service.remove(actor, { webhookId: created.webhook.id });

    const originalRun = await db.prisma.run.findUniqueOrThrow({ where: { id: receipt.runId! } });
    expect(originalRun.status).toBe("cancelled");
    const peerRun = await db.prisma.run.findUniqueOrThrow({ where: { id: peer.run.id } });
    expect(peerRun.status).toBe("cancelled");
    expect(peerRun.webhookId).toBeNull();
    expect(peerRun.leaseOwner).toBeNull();
    expect(peerRun.leaseExpiresAt).toBeNull();
    const peerTask = await db.prisma.task.findUniqueOrThrow({ where: { id: peerRun.taskId } });
    expect(peerTask.status).toBe("cancelled");
    const peerAttempt = await db.prisma.attempt.findFirstOrThrow({
      where: { runId: peer.run.id },
    });
    expect(peerAttempt.status).toBe("cancelled");
  });

  it("ignores an event whose type is not in the configured filter", async () => {
    const { actor, botId } = await newWorkspace();
    const { service } = harness();
    const created = await service.create(actor, {
      botId,
      name: "Builds",
      prompt: "",
      eventTypes: ["push"],
    });

    const ignored = await service.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "x" }, eventName: "pull_request" },
    });
    expect(ignored).toMatchObject({ outcome: "ignored", runId: null, duplicate: false });

    const accepted = await service.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "x" }, eventName: "push" },
    });
    expect(accepted.outcome).toBe("accepted");

    expect(await db.prisma.run.count({ where: { webhookId: created.webhook.id } })).toBe(1);
  });

  it("enforces a persistent rate limit of 10 deliveries per minute", async () => {
    const { actor, botId } = await newWorkspace();
    const base = new Date("2026-08-17T00:00:00.000Z");
    let tick = 0;
    const { service } = harness({ now: () => new Date(base.getTime() + tick * 1000) });
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });

    for (let i = 0; i < 10; i += 1) {
      tick += 1;
      const result = await service.receive({
        endpointId: created.webhook.endpointId,
        secret: created.secret,
        event: { payload: { task: `t${i}` }, deliveryId: `evt-rate-${i}` },
      });
      expect(result.outcome).toBe("accepted");
      // Complete each run immediately so this loop only ever exercises the per-minute
      // rate limit, never the separate three-nonterminal-runs cap.
      await db.prisma.run.update({ where: { id: result.runId! }, data: { status: "completed" } });
    }

    tick += 1;
    const eleventh = await service.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "t10" }, deliveryId: "evt-rate-10" },
    });
    expect(eleventh).toMatchObject({ outcome: "rejected", runId: null });
    expect(eleventh.statusCode).toBe(429);

    // Fresh state after the request survives a new service instance: the limit lives in
    // the database, not in process memory.
    tick = 90;
    const { service: freshService } = harness({
      now: () => new Date(base.getTime() + tick * 1000),
    });
    const afterWindow = await freshService.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "depois da janela" }, deliveryId: "evt-rate-after" },
    });
    expect(afterWindow.outcome).toBe("accepted");
  });

  it("does not let invalid-secret attempts consume the authenticated rate limit", async () => {
    const { actor, botId } = await newWorkspace();
    const { service } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });

    for (let i = 0; i < 10; i += 1) {
      const rejected = await service.receive({
        endpointId: created.webhook.endpointId,
        secret: "whsec_wrong",
        event: { payload: { task: `t${i}` } },
      });
      expect(rejected).toMatchObject({ outcome: "rejected", statusCode: 401 });
    }

    const valid = await service.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "primeira de verdade" }, deliveryId: "evt-after-invalid" },
    });
    expect(valid.outcome).toBe("accepted");
  });

  it("does not let duplicate-delivery retries consume the authenticated rate limit", async () => {
    const { actor, botId } = await newWorkspace();
    const { service } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });

    const first = await service.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "original" }, deliveryId: "evt-dup-rate" },
    });
    expect(first.outcome).toBe("accepted");

    for (let i = 0; i < 10; i += 1) {
      const retry = await service.receive({
        endpointId: created.webhook.endpointId,
        secret: created.secret,
        event: { payload: { task: "original" }, deliveryId: "evt-dup-rate" },
      });
      expect(retry.outcome).toBe("duplicate");
    }

    const secondDistinct = await service.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "segunda de verdade" }, deliveryId: "evt-dup-rate-2" },
    });
    expect(secondDistinct.outcome).toBe("accepted");
  });

  it("rejects new deliveries once three runs are non-terminal", async () => {
    const { actor, botId } = await newWorkspace();
    const { service } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });

    for (let i = 0; i < 3; i += 1) {
      const result = await service.receive({
        endpointId: created.webhook.endpointId,
        secret: created.secret,
        event: { payload: { task: `t${i}` }, deliveryId: `evt-cap-${i}` },
      });
      expect(result.outcome).toBe("accepted");
    }

    const fourth = await service.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "t3" }, deliveryId: "evt-cap-3" },
    });
    expect(fourth).toMatchObject({ outcome: "rejected", runId: null });

    const runs = await db.prisma.run.findMany({ where: { webhookId: created.webhook.id } });
    const [oneRun] = runs;
    await db.prisma.run.update({ where: { id: oneRun!.id }, data: { status: "completed" } });

    const afterCompletion = await service.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "t4" }, deliveryId: "evt-cap-4" },
    });
    expect(afterCompletion.outcome).toBe("accepted");
  });

  it("records the outcome and status code of every attempt", async () => {
    const { actor, botId } = await newWorkspace();
    const { service } = harness();
    const created = await service.create(actor, {
      botId,
      name: "Builds",
      prompt: "",
      eventTypes: ["push"],
    });

    await service.receive({
      endpointId: created.webhook.endpointId,
      secret: "whsec_wrong",
      event: { payload: {} },
    });
    await service.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "ok" }, eventName: "push", deliveryId: "evt-outcomes-1" },
    });
    await service.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "ok" }, eventName: "push", deliveryId: "evt-outcomes-1" },
    });
    await service.receive({
      endpointId: created.webhook.endpointId,
      secret: created.secret,
      event: { payload: { task: "ok" }, eventName: "issue" },
    });

    const attempts = await service.attempts(actor, { webhookId: created.webhook.id });
    const outcomes = attempts.map((attempt) => attempt.outcome).sort();
    expect(outcomes).toEqual(["accepted", "duplicate", "ignored", "rejected"]);
    for (const attempt of attempts) {
      expect(typeof attempt.statusCode).toBe("number");
    }
  });

  it("resolves the delivery race by returning the original run and a duplicate attempt without a second task or run", async () => {
    const { actor, botId } = await newWorkspace();
    const { service } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.receive({
          endpointId: created.webhook.endpointId,
          secret: created.secret,
          event: { payload: { task: "corrida" }, deliveryId: "evt-race" },
        }),
      ),
    );

    const accepted = results.filter((result) => result.outcome === "accepted");
    const duplicates = results.filter((result) => result.outcome === "duplicate");
    expect(accepted).toHaveLength(1);
    expect(duplicates).toHaveLength(4);
    for (const duplicate of duplicates) {
      expect(duplicate.runId).toBe(accepted[0]!.runId);
    }
    expect(await db.prisma.run.count({ where: { webhookId: created.webhook.id } })).toBe(1);
    expect(await db.prisma.task.count({ where: { botId } })).toBe(1);
  });

  it("lets three concurrent, distinct delivery ids all create their own run up to the nonterminal cap", async () => {
    const { actor, botId } = await newWorkspace();
    const { service, jobs } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });

    const results = await Promise.all(
      ["evt-distinct-1", "evt-distinct-2", "evt-distinct-3"].map((deliveryId) =>
        service.receive({
          endpointId: created.webhook.endpointId,
          secret: created.secret,
          event: { payload: { task: deliveryId }, deliveryId },
        }),
      ),
    );

    expect(results.map((result) => result.outcome)).toEqual(["accepted", "accepted", "accepted"]);
    const runIds = new Set(results.map((result) => result.runId));
    expect(runIds.size).toBe(3);
    expect(await db.prisma.run.count({ where: { webhookId: created.webhook.id } })).toBe(3);
    expect(jobs).toHaveLength(3);
  });

  it("resolves a same-delivery-id race under concurrency by retrying through load and authentication, not by bypassing the secret", async () => {
    const { actor, botId } = await newWorkspace();
    const { service } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });

    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        service.receive({
          endpointId: created.webhook.endpointId,
          secret: created.secret,
          event: { payload: { task: "corrida" }, deliveryId: "evt-race-retry" },
        }),
      ),
    );

    const accepted = results.filter((result) => result.outcome === "accepted");
    const duplicates = results.filter((result) => result.outcome === "duplicate");
    expect(accepted).toHaveLength(1);
    expect(duplicates).toHaveLength(2);
    // The invalid-secret retry must go through the same authentication gate as any other
    // call: the retry never returns an outcome the secret alone could not have earned.
    const withWrongSecretAfterRace = await service.receive({
      endpointId: created.webhook.endpointId,
      secret: "whsec_wrong",
      event: { payload: { task: "corrida" }, deliveryId: "evt-race-retry" },
    });
    expect(withWrongSecretAfterRace).toMatchObject({ outcome: "rejected", statusCode: 401 });
    expect(await db.prisma.run.count({ where: { webhookId: created.webhook.id } })).toBe(1);
  });

  it("authorizes a valid endpoint/secret pair without touching the body", async () => {
    const { actor, botId } = await newWorkspace();
    const { service } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });

    expect(
      await service.authorize(created.webhook.endpointId, created.secret, {
        eventName: "push",
      }),
    ).toBe(true);
    // authorize() never creates an attempt on success: receive() alone is the record of
    // what actually happened to a delivery.
    expect(await service.attempts(actor, { webhookId: created.webhook.id })).toEqual([]);
  });

  it("returns false for an invalid secret on a known endpoint and records a 401 attempt", async () => {
    const { actor, botId } = await newWorkspace();
    const { service } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });

    expect(await service.authorize(created.webhook.endpointId, "whsec_wrong")).toBe(false);
    const attempts = await service.attempts(actor, { webhookId: created.webhook.id });
    expect(attempts).toMatchObject([{ outcome: "rejected", statusCode: 401 }]);
  });

  it("returns false for an unknown endpoint without revealing that it does not exist", async () => {
    const { service } = harness();
    // Same return value and shape as an invalid secret on a real endpoint: false, no throw.
    await expect(service.authorize("wh_does_not_exist", "whsec_anything")).resolves.toBe(false);
  });

  it("recordRejected creates a rejected attempt for a known endpoint, without any secret check", async () => {
    const { actor, botId } = await newWorkspace();
    const { service } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });

    await service.recordRejected(created.webhook.endpointId, 400, "invalid_json", {
      eventName: "push",
      deliveryId: "evt-bad-json",
    });

    const attempts = await service.attempts(actor, { webhookId: created.webhook.id });
    expect(attempts).toMatchObject([
      {
        outcome: "rejected",
        statusCode: 400,
        reason: "invalid_json",
        eventName: "push",
        deliveryId: "evt-bad-json",
      },
    ]);
  });

  it("recordRejected is a silent no-op for an unknown endpoint, so a route never has to guard against it", async () => {
    const { service } = harness();
    await expect(
      service.recordRejected("wh_does_not_exist", 400, "invalid_json"),
    ).resolves.toBeUndefined();
  });

  it("still re-authenticates inside receive() even after authorize() approved a secret that then rotated", async () => {
    const { actor, botId } = await newWorkspace();
    const { service } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });
    const oldSecret = created.secret;

    expect(await service.authorize(created.webhook.endpointId, oldSecret)).toBe(true);
    await service.rotateSecret(actor, { webhookId: created.webhook.id });

    const result = await service.receive({
      endpointId: created.webhook.endpointId,
      secret: oldSecret,
      event: { payload: { task: "não deveria passar" } },
    });
    expect(result).toMatchObject({ outcome: "rejected", statusCode: 401 });
  });

  it("testRun creates a run using the actor's ownership instead of a secret, with a default payload", async () => {
    const { actor, botId } = await newWorkspace();
    const { service, jobs, prompts } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });

    const result = await service.testRun(actor, created.webhook.id);

    expect(result.outcome).toBe("accepted");
    expect(result.runId).not.toBeNull();
    const run = await db.prisma.run.findUniqueOrThrow({ where: { id: result.runId! } });
    expect(run.trigger).toBe("webhook");
    expect(run.webhookId).toBe(created.webhook.id);
    expect(jobs).toEqual([
      {
        name: "run.continue",
        payload: { runId: result.runId },
        jobKey: `run.continue:${result.runId}`,
      },
    ]);
    expect(prompts).toHaveLength(1);
    expect((prompts[0] as { event: { payload: unknown } }).event.payload).toEqual({
      event: "quibt.test",
      task: "Teste de webhook",
    });
  });

  it("testRun rejects a webhook owned by a different actor with IsolationError, never a secret check", async () => {
    const { actor, botId } = await newWorkspace();
    const other = await newWorkspace();
    const { service } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });

    await expect(service.testRun(other.actor, created.webhook.id)).rejects.toThrow(IsolationError);
    expect(await db.prisma.run.count({ where: { webhookId: created.webhook.id } })).toBe(0);
  });

  it("testRun without an event name still fires when the webhook filters event types", async () => {
    const { actor, botId } = await newWorkspace();
    const { service } = harness();
    const created = await service.create(actor, {
      botId,
      name: "Builds",
      prompt: "",
      eventTypes: ["push"],
    });

    const result = await service.testRun(actor, created.webhook.id);

    expect(result.outcome).toBe("accepted");
    expect(result.runId).not.toBeNull();
  });

  it("testRun accepts a custom event payload and event name", async () => {
    const { actor, botId } = await newWorkspace();
    const { service, prompts } = harness();
    const created = await service.create(actor, {
      botId,
      name: "Builds",
      prompt: "",
      eventTypes: ["push"],
    });

    const result = await service.testRun(actor, created.webhook.id, {
      payload: { task: "evento customizado" },
      eventName: "push",
    });

    expect(result.outcome).toBe("accepted");
    expect((prompts[0] as { event: { payload: unknown } }).event.payload).toEqual({
      task: "evento customizado",
    });
  });

  it("testRun uses a synthetic delivery id each call so repeated test runs never dedupe against each other", async () => {
    const { actor, botId } = await newWorkspace();
    const { service } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });

    const first = await service.testRun(actor, created.webhook.id);
    const second = await service.testRun(actor, created.webhook.id);

    expect(first.runId).not.toBe(second.runId);
    expect(await db.prisma.run.count({ where: { webhookId: created.webhook.id } })).toBe(2);
  });

  it("testRun is subject to the same nonterminal-run cap as receive()", async () => {
    const { actor, botId } = await newWorkspace();
    const { service } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });

    for (let i = 0; i < 3; i += 1) {
      const result = await service.receive({
        endpointId: created.webhook.endpointId,
        secret: created.secret,
        event: { payload: { task: `t${i}` }, deliveryId: `evt-testrun-cap-${i}` },
      });
      expect(result.outcome).toBe("accepted");
    }

    const testResult = await service.testRun(actor, created.webhook.id);
    expect(testResult).toMatchObject({ outcome: "rejected", runId: null });
  });

  it("clamps the attempts limit to between 1 and 100 regardless of what the caller requests", async () => {
    const { actor, botId } = await newWorkspace();
    const { service } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });

    for (let i = 0; i < 105; i += 1) {
      await service.receive({
        endpointId: created.webhook.endpointId,
        secret: "whsec_wrong",
        event: { payload: {} },
      });
    }

    const capped = await service.attempts(actor, { webhookId: created.webhook.id, limit: 100_000 });
    expect(capped).toHaveLength(100);

    const flooredToOne = await service.attempts(actor, { webhookId: created.webhook.id, limit: 0 });
    expect(flooredToOne).toHaveLength(1);

    const negative = await service.attempts(actor, { webhookId: created.webhook.id, limit: -5 });
    expect(negative).toHaveLength(1);
  });

  it("validates the outcome when mapping an attempt instead of blindly casting a corrupted value", async () => {
    const { actor, botId } = await newWorkspace();
    const { service } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });
    await db.prisma.webhookAttempt.create({
      data: {
        webhookId: created.webhook.id,
        outcome: "not-a-real-outcome",
        statusCode: 999,
        receivedAt: new Date(),
      },
    });

    await expect(service.attempts(actor, { webhookId: created.webhook.id })).rejects.toThrow();
  });

  it("does not process the payload before authentication succeeds", async () => {
    const { actor, botId } = await newWorkspace();
    const { service, prompts } = harness();
    const created = await service.create(actor, { botId, name: "Builds", prompt: "" });

    const throwingPayload = {
      get task(): string {
        throw new Error("payload accessed before auth");
      },
    };
    await expect(
      service.receive({
        endpointId: created.webhook.endpointId,
        secret: "whsec_wrong",
        event: { payload: throwingPayload },
      }),
    ).resolves.toMatchObject({ outcome: "rejected" });
    expect(prompts).toHaveLength(0);
  });
});
