import { randomBytes } from "node:crypto";
import { call, ORPCError } from "@orpc/server";
import type { Actor } from "@quibt/contracts";
import { createDb, createWebhookService, type WebhookWakeup } from "@quibt/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AppHandles, createApp } from "./app.js";
import { resetRateLimits, webhookEndpointBucket } from "./rate-limit.js";
import { createRouter, type RouterDeps } from "./router.js";

const hasDb = Boolean(process.env.DATABASE_URL);
const describeDb = hasDb ? describe : describe.skip;

/**
 * Drives the real Hono app end to end: authentication, `bodyLimit`, payload parsing,
 * and `WebhookReceiveResult` -> HTTP status mapping all run for real, against real
 * Postgres, exactly as a live delivery would. Guarded on `DATABASE_URL` like
 * `packages/db/src/webhooks.pg.test.ts`, so `verify:fast` (which never sets it for the
 * test step) skips this cleanly and CI's `migrations-and-journeys` job runs it for real.
 */
describeDb("webhook HTTP ingress", () => {
  let handles: AppHandles;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let workspaceCounter = 0;

  beforeAll(async () => {
    // `trustedProxyIps: ["local"]` lets these tests simulate distinct client IPs via
    // `x-real-ip`, the same header a trusted reverse proxy would set: `app.request()`
    // never has a real socket, so the peer always resolves to the "local" fallback.
    handles = await createApp({ trustedProxyIps: ["local"] });
  });

  afterAll(async () => {
    await handles.stop();
  });

  beforeEach(() => resetRateLimits());
  afterEach(() => resetRateLimits());

  async function newWorkspace() {
    workspaceCounter += 1;
    const workspaceId = `ws-hooks-${stamp}-${workspaceCounter}`;
    const userId = `user-hooks-${stamp}-${workspaceCounter}`;
    await handles.prisma.organization.create({
      data: {
        id: workspaceId,
        name: "Webhook workspace",
        slug: `hooks-${stamp}-${workspaceCounter}`,
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
    const bot = await handles.prisma.bot.create({
      data: { workspaceId, userId, name: "Webhook bot", color: "#123456" },
    });
    await handles.prisma.thread.create({ data: { workspaceId, userId, botId: bot.id } });
    return { actor, botId: bot.id };
  }

  async function newWebhook(overrides: { eventTypes?: string[] } = {}) {
    const { actor, botId } = await newWorkspace();
    const created = await handles.webhookService.create(actor, {
      botId,
      name: "Test hook",
      prompt: "",
      eventTypes: overrides.eventTypes,
    });
    return { actor, botId, ...created };
  }

  describe("GET /hooks/health", () => {
    it("exposes no main API data", async () => {
      const res = await handles.app.request("http://localhost/hooks/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ app: "quibt-webhooks", ready: true });
      expect(res.headers.get("cache-control")).toBe("no-store");
    });
  });

  describe("POST /hooks/:endpointId", () => {
    it("accepts a Bearer-authenticated JSON delivery", async () => {
      const { webhook, secret } = await newWebhook();
      const res = await handles.app.request(`http://localhost/hooks/${webhook.endpointId}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          "idempotency-key": "delivery-1",
        },
        body: JSON.stringify({ task: "Revise o build" }),
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ accepted: true, duplicate: false });
    });

    it("accepts the private secret-in-path URL", async () => {
      const { webhook, secret } = await newWebhook();
      const res = await handles.app.request(
        `http://localhost/hooks/${webhook.endpointId}/${secret}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task: "Revise o build" }),
        },
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ accepted: true, duplicate: false });
    });

    it("checks the secret before ever looking at the body: a wrong secret with an oversized, malformed body still 401s", async () => {
      const { webhook } = await newWebhook();
      const oversized = "{".repeat(300 * 1024);
      const res = await handles.app.request(`http://localhost/hooks/${webhook.endpointId}`, {
        method: "POST",
        headers: { authorization: "Bearer whsec_wrong", "content-type": "application/json" },
        body: oversized,
      });
      expect(res.status).toBe(401);
    });

    it("returns an indistinguishable 401 for an unknown endpoint", async () => {
      const res = await handles.app.request("http://localhost/hooks/wh_does_not_exist", {
        method: "POST",
        headers: { authorization: "Bearer whsec_whatever", "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(401);
    });

    it("parses JSON, urlencoded form, and plain text bodies", async () => {
      const json = await newWebhook();
      const jsonRes = await handles.app.request(
        `http://localhost/hooks/${json.webhook.endpointId}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${json.secret}`, "content-type": "application/json" },
          body: JSON.stringify({ task: "a" }),
        },
      );
      expect(jsonRes.status).toBe(202);

      const form = await newWebhook();
      const formRes = await handles.app.request(
        `http://localhost/hooks/${form.webhook.endpointId}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${form.secret}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "task=hello",
        },
      );
      expect(formRes.status).toBe(202);

      const text = await newWebhook();
      const textRes = await handles.app.request(
        `http://localhost/hooks/${text.webhook.endpointId}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${text.secret}`, "content-type": "text/plain" },
          body: "hello there",
        },
      );
      expect(textRes.status).toBe(202);
    });

    it("accepts an authenticated empty JSON ping as 202, not 400", async () => {
      const { webhook, secret } = await newWebhook();
      const res = await handles.app.request(`http://localhost/hooks/${webhook.endpointId}`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: "",
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ accepted: true });
    });

    it("rejects invalid JSON as 400 and records a rejected attempt", async () => {
      const { webhook, secret, actor } = await newWebhook();
      const res = await handles.app.request(`http://localhost/hooks/${webhook.endpointId}`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: "{not valid json",
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ accepted: false });
      const attempts = await handles.webhookService.attempts(actor, { webhookId: webhook.id });
      expect(attempts[0]).toMatchObject({
        outcome: "rejected",
        statusCode: 400,
        reason: "invalid_json",
      });
    });

    it("rejects an oversized body as 413 and records a rejected attempt", async () => {
      const { webhook, secret, actor } = await newWebhook();
      const oversized = "x".repeat(300 * 1024);
      const res = await handles.app.request(`http://localhost/hooks/${webhook.endpointId}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "text/plain",
          "content-length": String(Buffer.byteLength(oversized)),
        },
        body: oversized,
      });
      expect(res.status).toBe(413);
      const attempts = await handles.webhookService.attempts(actor, { webhookId: webhook.id });
      expect(attempts[0]).toMatchObject({ outcome: "rejected", statusCode: 413 });
    });

    it("rejects an oversized chunked body with no Content-Length as 413, after authorizing first", async () => {
      const { webhook, secret, actor } = await newWebhook();
      const chunk = "x".repeat(64 * 1024);
      const totalChunks = 6; // 6 * 64 KiB = 384 KiB, above WEBHOOK_MAX_BODY_BYTES (256 KiB)
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const bytes = new TextEncoder().encode(chunk);
          for (let i = 0; i < totalChunks; i += 1) controller.enqueue(bytes);
          controller.close();
        },
      });
      const res = await handles.app.request(`http://localhost/hooks/${webhook.endpointId}`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "text/plain" },
        body: stream,
        // Node's fetch requires this when the body is a stream, and it is exactly what
        // makes the request have no Content-Length: the size is genuinely unknown upfront,
        // so `bodyLimit` has to fall back to counting bytes as they stream in.
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      expect(res.status).toBe(413);
      const attempts = await handles.webhookService.attempts(actor, { webhookId: webhook.id });
      expect(attempts[0]).toMatchObject({ outcome: "rejected", statusCode: 413 });
    });

    it("returns the original run for a retried idempotency key instead of creating a second one", async () => {
      const { webhook, secret } = await newWebhook();
      const first = await handles.app.request(`http://localhost/hooks/${webhook.endpointId}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          "idempotency-key": "dup-1",
        },
        body: JSON.stringify({ task: "a" }),
      });
      const firstBody = (await first.json()) as { runId: string | null };
      const retry = await handles.app.request(`http://localhost/hooks/${webhook.endpointId}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          "idempotency-key": "dup-1",
        },
        body: JSON.stringify({ task: "a" }),
      });
      expect(retry.status).toBe(202);
      expect(await retry.json()).toMatchObject({
        accepted: true,
        duplicate: true,
        runId: firstBody.runId,
      });
    });

    it("survives a 3000-byte Idempotency-Key without a 500, storing a clamped, safe deliveryId", async () => {
      const { webhook, secret, actor } = await newWebhook();
      // Random (incompressible) bytes, not a repeated character: a highly compressible key
      // would let Postgres's TOAST/pglz compression mask the underlying oversized-index-key
      // problem this test is meant to catch.
      const hugeKey = randomBytes(1500).toString("hex");
      const res = await handles.app.request(`http://localhost/hooks/${webhook.endpointId}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          "idempotency-key": hugeKey,
        },
        body: JSON.stringify({ task: "a" }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { accepted: boolean; runId: string | null };
      expect(body.accepted).toBe(true);
      const attempts = await handles.webhookService.attempts(actor, { webhookId: webhook.id });
      expect(attempts[0]?.deliveryId).not.toBeNull();
      expect(attempts[0]?.deliveryId?.length).toBeLessThanOrEqual(200);
      expect(attempts[0]?.deliveryId).toBe(hugeKey.slice(0, 200));

      // Truncation is deterministic, so a retry with the exact same oversized key still
      // dedupes against the clamped value already stored — it must not look like a new,
      // never-seen delivery just because the key was clamped.
      const retry = await handles.app.request(`http://localhost/hooks/${webhook.endpointId}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          "idempotency-key": hugeKey,
        },
        body: JSON.stringify({ task: "a" }),
      });
      expect(retry.status).toBe(202);
      expect(await retry.json()).toMatchObject({
        accepted: true,
        duplicate: true,
        runId: body.runId,
      });
    });

    it("returns 409 for a paused webhook", async () => {
      const { webhook, secret, actor } = await newWebhook();
      await handles.webhookService.update(actor, { webhookId: webhook.id, active: false });
      const res = await handles.app.request(`http://localhost/hooks/${webhook.endpointId}`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ task: "a" }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ accepted: false, error: "paused" });
    });

    it("returns 429 once the per-minute delivery limit is exceeded", async () => {
      const { webhook, secret } = await newWebhook();
      // Fills the persistent per-minute counter via `service.receive()` directly and
      // completes each run immediately, so this only exercises the rate limit — not the
      // separate nonterminal-run cap, which a real HTTP delivery's async `run.continue`
      // would otherwise race against. The 11th delivery is the one actually going
      // through the real HTTP route, to prove the ingress maps 429 correctly.
      for (let i = 0; i < 10; i += 1) {
        const result = await handles.webhookService.receive({
          endpointId: webhook.endpointId,
          secret,
          event: { payload: { task: "a" }, deliveryId: `evt-${i}` },
        });
        expect(result.outcome).toBe("accepted");
        if (result.runId) {
          await handles.prisma.run.update({
            where: { id: result.runId },
            data: { status: "succeeded", completedAt: new Date() },
          });
        }
      }
      const limited = await handles.app.request(`http://localhost/hooks/${webhook.endpointId}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          "idempotency-key": "evt-11",
        },
        body: JSON.stringify({ task: "a" }),
      });
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ accepted: false, error: "rate_limited" });
    });

    it("ignores a filtered event type but still answers 202 with no run", async () => {
      const { webhook, secret } = await newWebhook({ eventTypes: ["push"] });
      const res = await handles.app.request(`http://localhost/hooks/${webhook.endpointId}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          "x-webhook-event": "issue_comment",
        },
        body: JSON.stringify({ task: "a" }),
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ accepted: true, runId: null });
    });
  });

  describe("unexpected processor failures on /hooks/*", () => {
    it("returns a generic, no-store JSON 500 (never internals) when receive() throws unexpectedly", async () => {
      const { webhook, secret } = await newWebhook();
      const originalReceive = handles.webhookService.receive;
      handles.webhookService.receive = async () => {
        throw new Error("boom: something the DB driver only says internally");
      };
      try {
        const res = await handles.app.request(`http://localhost/hooks/${webhook.endpointId}`, {
          method: "POST",
          headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
          body: JSON.stringify({ task: "a" }),
        });
        expect(res.status).toBe(500);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const body = await res.json();
        // Same machine-readable, snake_case token every other /hooks/* error uses
        // ("invalid_secret", "invalid_json", "rate_limited", ...) and the same one
        // service.recordRejected() already stores as the attempt's `reason`.
        expect(body).toEqual({ accepted: false, error: "processing_failed" });
        expect(JSON.stringify(body)).not.toMatch(/boom|stack|driver/i);
      } finally {
        handles.webhookService.receive = originalReceive;
      }
    });

    it("returns the same generic 500 on a real delete-between-authorize-and-receive race, and a failed best-effort recordRejected never changes the response", async () => {
      const { webhook, secret } = await newWebhook();
      const originalAuthorize = handles.webhookService.authorize;
      handles.webhookService.authorize = async (...args: Parameters<typeof originalAuthorize>) => {
        const authorized = await originalAuthorize(...args);
        // Simulates another request deleting the webhook in the window between this
        // middleware's authorize() call and the processor's own receive() call.
        await handles.prisma.webhook.delete({ where: { id: webhook.id } }).catch(() => undefined);
        return authorized;
      };
      try {
        const res = await handles.app.request(`http://localhost/hooks/${webhook.endpointId}`, {
          method: "POST",
          headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
          body: JSON.stringify({ task: "a" }),
        });
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ accepted: false, error: "processing_failed" });
        // The webhook is gone, so best-effort recordRejected() has nothing to attach a row
        // to; the important part is that it never crashed the process or changed the
        // response above — which the assertions before this comment already prove.
      } finally {
        handles.webhookService.authorize = originalAuthorize;
      }
    });
  });

  describe("pre-auth rate limiting on /hooks/*", () => {
    // Only the rate limiter is under test here, so a synthetic, never-created endpoint
    // id works exactly like a real one: an unauthenticated `/hooks/*` POST gets the same
    // indistinguishable 401 either way, and `allowWebhookRequest` runs before either case
    // is decided.
    function wrongSecretRequest(endpointId: string, ip: string) {
      return handles.app.request(`http://localhost/hooks/${endpointId}`, {
        method: "POST",
        headers: {
          authorization: "Bearer whsec_wrong",
          "content-type": "application/json",
          "x-real-ip": ip,
        },
        body: "{}",
      });
    }

    it("stops a wrong-secret flood at a single endpoint's bucket limit (30/min) and records no attempts beyond it", async () => {
      const { webhook, actor } = await newWebhook();
      const ip = "203.0.113.10";
      let lastStatus = 0;
      for (let i = 0; i < 35; i += 1) {
        const res = await wrongSecretRequest(webhook.endpointId, ip);
        lastStatus = res.status;
        if (i < 30) {
          expect(res.status).toBe(401);
        } else {
          expect(res.status).toBe(429);
          expect(await res.json()).toMatchObject({ accepted: false, error: "rate_limited" });
        }
      }
      expect(lastStatus).toBe(429);
      const attempts = await handles.webhookService.attempts(actor, { webhookId: webhook.id });
      const invalidSecretAttempts = attempts.filter((a) => a.reason === "invalid_secret");
      // Every attempt up to and including the limit hit authorize() and recorded one; the
      // 5 that got 429 never reached authorize(), so no new rows were created for them.
      expect(invalidSecretAttempts.length).toBeLessThanOrEqual(30);
    });

    it("closes distributed enumeration across many invented endpoint ids with the per-IP global ceiling (60/min)", async () => {
      const ip = "203.0.113.20";
      // 60 different, never-created endpoint ids: no single one gets anywhere near the
      // 30/min per-endpoint-bucket limit, so only the per-IP global ceiling explains the
      // 429 that must show up by the 61st attempt.
      for (let i = 0; i < 60; i += 1) {
        const res = await wrongSecretRequest(`invented-${randomBytes(6).toString("hex")}`, ip);
        expect(res.status).toBe(401);
      }
      const blocked = await wrongSecretRequest(`invented-${randomBytes(6).toString("hex")}`, ip);
      expect(blocked.status).toBe(429);
      expect(await blocked.json()).toMatchObject({ accepted: false, error: "rate_limited" });
    });

    it("does not share rate-limit state across a different endpoint bucket or a different IP", async () => {
      const ipX = "198.51.100.1";
      const ipY = "198.51.100.2";
      const endpointA = "wh_bucket_target_a";
      // Deterministically picks an endpoint id whose bucket differs from A's, so this
      // test never depends on two independently-created webhook ids happening to land
      // in different buckets by luck.
      const bucketA = webhookEndpointBucket(endpointA);
      let endpointB = "wh_bucket_target_b";
      for (let i = 0; webhookEndpointBucket(endpointB) === bucketA; i += 1) {
        endpointB = `wh_bucket_target_b_${i}`;
      }

      for (let i = 0; i < 30; i += 1) {
        expect((await wrongSecretRequest(endpointA, ipX)).status).toBe(401);
      }
      const aFromXBlocked = await wrongSecretRequest(endpointA, ipX);
      expect(aFromXBlocked.status).toBe(429);

      // Same endpoint, different IP: an entirely fresh global + bucket state.
      const aFromYAllowed = await wrongSecretRequest(endpointA, ipY);
      expect(aFromYAllowed.status).toBe(401);

      // A different endpoint bucket, same (bucket-exhausted) IP: well under that IP's
      // global ceiling (31 attempts so far), and this specific bucket was never touched.
      const bFromXAllowed = await wrongSecretRequest(endpointB, ipX);
      expect(bFromXAllowed.status).toBe(401);
    });
  });

  describe("unknown routes", () => {
    it("404s for unknown paths and methods without exposing the API", async () => {
      const missing = await handles.app.request("http://localhost/hooks/nope/nope/nope");
      expect(missing.status).toBe(404);
      const wrongMethod = await handles.app.request("http://localhost/hooks/wh_x", {
        method: "GET",
      });
      expect(wrongMethod.status).toBe(404);
    });
  });
});

/**
 * Administration goes through `createRouter` directly (like `router-edition.test.ts`),
 * but with `@quibt/db`'s real `createWebhookService` against real Postgres instead of a
 * hand-written fake: isolation, the CRUD/rotate/attempts/testRun surface, and the
 * one-time secret all depend on the actual persistence rules Task 3 built, not on a
 * fake that could silently drift from them.
 */
describeDb("webhook administration via oRPC", () => {
  let db: ReturnType<typeof createDb>;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let workspaceCounter = 0;

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  function harness() {
    const wakeup: WebhookWakeup = { enqueue: async () => undefined };
    const webhookService = createWebhookService({
      prisma: db.prisma,
      wakeup,
      buildPrompt: () => "prompt:test",
    });
    const deps = {
      prisma: db.prisma,
      webhookService,
      env: { apiUrl: "http://127.0.0.1:3100" },
    } as unknown as RouterDeps;
    return createRouter(deps);
  }

  async function newActorWithBot() {
    workspaceCounter += 1;
    const workspaceId = `ws-admin-${stamp}-${workspaceCounter}`;
    const userId = `user-admin-${stamp}-${workspaceCounter}`;
    await db.prisma.organization.create({
      data: {
        id: workspaceId,
        name: "Admin workspace",
        slug: `admin-${stamp}-${workspaceCounter}`,
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
      data: { workspaceId, userId, name: "Admin bot", color: "#654321" },
    });
    await db.prisma.thread.create({ data: { workspaceId, userId, botId: bot.id } });
    return { actor, botId: bot.id };
  }

  it("round-trips deployment.update({ webhookPublicUrl }) through a real DB: normalizes, clears with null, and stays owner-only", async () => {
    const router = harness();
    const owner: Actor = {
      userId: `deploy-owner-${stamp}`,
      workspaceId: `ws-deploy-${stamp}`,
      workspaceRole: "owner",
      email: `deploy-owner-${stamp}@example.com`,
      isDeploymentOwner: true,
    };
    const nonOwner: Actor = {
      ...owner,
      userId: `deploy-nonowner-${stamp}`,
      isDeploymentOwner: false,
    };

    try {
      await expect(
        call(
          router.deployment.update,
          { webhookPublicUrl: "https://tunnel.example.com" },
          { context: { actor: nonOwner } },
        ),
      ).rejects.toBeInstanceOf(ORPCError);

      const updated = await call(
        router.deployment.update,
        { webhookPublicUrl: "https://tunnel.example.com/" },
        { context: { actor: owner } },
      );
      expect(updated.webhookPublicUrl).toBe("https://tunnel.example.com");

      const fetched = await call(router.deployment.get, undefined, { context: { actor: owner } });
      expect(fetched.webhookPublicUrl).toBe("https://tunnel.example.com");
      await expect(
        call(router.deployment.get, undefined, { context: { actor: nonOwner } }),
      ).rejects.toBeInstanceOf(ORPCError);

      const cleared = await call(
        router.deployment.update,
        { webhookPublicUrl: null },
        { context: { actor: owner } },
      );
      expect(cleared.webhookPublicUrl).toBeNull();
    } finally {
      // `deployment_settings` is a singleton row shared with every other test/process
      // touching this database: leave it the way this test found it.
      await db.prisma.deploymentSettings
        .update({ where: { id: "default" }, data: { webhookPublicUrl: null } })
        .catch(() => undefined);
    }
  });

  it("creates, lists, updates, tests, gets attempts, rotates, and removes a webhook — all through context.actor", async () => {
    const router = harness();
    const { actor, botId } = await newActorWithBot();

    const created = await call(
      router.webhooks.create,
      { botId, name: "Builds", prompt: "" },
      { context: { actor } },
    );
    expect(created.webhook.name).toBe("Builds");
    expect(created.credential).toEqual({
      endpointUrl: `http://127.0.0.1:3100/hooks/${created.webhook.endpointId}`,
      secret: created.credential.secret,
      url: `http://127.0.0.1:3100/hooks/${created.webhook.endpointId}/${created.credential.secret}`,
    });

    const listed = await call(router.webhooks.list, { botId }, { context: { actor } });
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("secretHash");
    expect(listed[0]).not.toHaveProperty("secret");

    const updated = await call(
      router.webhooks.update,
      { webhookId: created.webhook.id, name: "Builds v2" },
      { context: { actor } },
    );
    expect(updated.name).toBe("Builds v2");

    const testRun = await call(
      router.webhooks.testRun,
      { webhookId: created.webhook.id },
      { context: { actor } },
    );
    expect(testRun.runId).toBeTruthy();

    const attempts = await call(
      router.webhooks.attempts,
      { webhookId: created.webhook.id },
      { context: { actor } },
    );
    expect(attempts[0]).toMatchObject({ outcome: "accepted" });
    expect(attempts[0]).not.toHaveProperty("secret");

    const rotated = await call(
      router.webhooks.rotateSecret,
      { webhookId: created.webhook.id },
      { context: { actor } },
    );
    expect(rotated.credential.secret).not.toBe(created.credential.secret);

    await call(router.webhooks.remove, { webhookId: created.webhook.id }, { context: { actor } });
    const afterRemove = await call(router.webhooks.list, { botId }, { context: { actor } });
    expect(afterRemove).toHaveLength(0);
  });

  it("keeps one workspace's webhooks isolated from another's", async () => {
    const router = harness();
    const a = await newActorWithBot();
    const b = await newActorWithBot();
    const created = await call(
      router.webhooks.create,
      { botId: a.botId, name: "A's hook", prompt: "" },
      { context: { actor: a.actor } },
    );

    await expect(
      call(
        router.webhooks.update,
        { webhookId: created.webhook.id, name: "steal" },
        { context: { actor: b.actor } },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
    await expect(
      call(
        router.webhooks.attempts,
        { webhookId: created.webhook.id },
        { context: { actor: b.actor } },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
    await expect(
      call(
        router.webhooks.rotateSecret,
        { webhookId: created.webhook.id },
        { context: { actor: b.actor } },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
    await expect(
      call(router.webhooks.list, { botId: a.botId }, { context: { actor: b.actor } }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it("turns a rejected testRun (a paused webhook) into a coherent ORPCError, never {runId: null}", async () => {
    const router = harness();
    const { actor, botId } = await newActorWithBot();
    const created = await call(
      router.webhooks.create,
      { botId, name: "Paused", prompt: "" },
      { context: { actor } },
    );
    await call(
      router.webhooks.update,
      { webhookId: created.webhook.id, active: false },
      { context: { actor } },
    );
    await expect(
      call(router.webhooks.testRun, { webhookId: created.webhook.id }, { context: { actor } }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it("never lets the one-time create/rotate secret reappear in list or attempts", async () => {
    const router = harness();
    const { actor, botId } = await newActorWithBot();
    const created = await call(
      router.webhooks.create,
      { botId, name: "Secret test", prompt: "" },
      { context: { actor } },
    );
    const listed = await call(router.webhooks.list, { botId }, { context: { actor } });
    expect(JSON.stringify(listed)).not.toContain(created.credential.secret);

    const attempts = await call(
      router.webhooks.attempts,
      { webhookId: created.webhook.id },
      { context: { actor } },
    );
    expect(JSON.stringify(attempts)).not.toContain(created.credential.secret);

    const rotated = await call(
      router.webhooks.rotateSecret,
      { webhookId: created.webhook.id },
      { context: { actor } },
    );
    const relisted = await call(router.webhooks.list, { botId }, { context: { actor } });
    expect(JSON.stringify(relisted)).not.toContain(rotated.credential.secret);
    expect(JSON.stringify(relisted)).not.toContain(created.credential.secret);
  });
});
