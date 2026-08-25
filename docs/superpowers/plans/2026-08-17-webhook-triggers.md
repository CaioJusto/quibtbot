# Webhook Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar gatilhos HTTP autenticados que iniciem tarefas duráveis em um bot individual do Quibt, em VPS ou pela URL de túnel configurada pelo usuário.

**Architecture:** A API Hono recebe eventos em `/hooks/*`, enquanto o oRPC autenticado administra os webhooks. Um serviço de domínio persistido em PostgreSQL autentica, deduplica e cria `Task` + `Run(trigger="webhook")`; o worker existente executa `run.continue`. A UI fica nas configurações do bot e apenas monta URLs a partir do domínio da VPS ou do túnel externo informado pela pessoa.

**Tech Stack:** TypeScript 5.9, Hono, oRPC, Zod, Prisma/PostgreSQL, Vitest, React 19, Playwright.

## Global Constraints

- O Quibt não oferece, revende ou opera Cloud, relay ou túnel.
- Webhooks pertencem somente a bots individuais nesta versão.
- O bot usa seu modelo, permissões e máquina já configurados.
- Todo código de produção nasce depois de um teste que falha pelo motivo esperado.
- Usar apenas tokens `--qb-*` e o sistema visual claro; não copiar o design do OpenMausBot.
- Não adicionar dependências.
- Limites: corpo de 256 KiB, payload de modelo limitado, 10 entregas/minuto e 3 runs inacabados por webhook.

---

### Task 1: Contratos e persistência

**Files:**
- Modify: `packages/contracts/src/domain.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `packages/contracts/src/index.test.ts`
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/0020_webhook_triggers/migration.sql`

**Interfaces:**
- Produces: `WebhookSchema`, `WebhookAttemptSchema`, `WebhookCredentialSchema`, `CreateWebhookInput`, `UpdateWebhookInput`.
- Produces: `appContract.webhooks.{list,create,update,remove,rotateSecret,testRun,attempts}`.
- Produces: `DeploymentSettingsSchema.webhookPublicUrl`.
- Produces: Prisma models `Webhook`, `WebhookAttempt`, `WebhookDelivery` and `Run.webhookId`.

- [ ] **Step 1: Write failing contract tests**

Add assertions to `packages/contracts/src/index.test.ts`:

```ts
expect(appContract.webhooks.create).toBeTruthy();
expect(appContract.webhooks.rotateSecret).toBeTruthy();
expect(
  CreateWebhookInput.safeParse({
    botId: "bot",
    name: "Builds",
    prompt: "",
    eventTypes: ["push"],
  }).success,
).toBe(true);
expect(
  CreateWebhookInput.safeParse({
    botId: "bot",
    name: "",
    prompt: "x".repeat(MAX_MODEL_INPUT_CHARS + 1),
  }).success,
).toBe(false);
```

- [ ] **Step 2: Run the contracts test and verify RED**

Run: `pnpm exec vitest run packages/contracts/src/index.test.ts`

Expected: FAIL because `CreateWebhookInput` and `appContract.webhooks` do not exist.

- [ ] **Step 3: Add schemas and RPC surface**

Define:

```ts
export const WebhookOutcome = z.enum(["accepted", "duplicate", "ignored", "rejected"]);
export const WebhookSchema = z.object({
  id: Id,
  endpointId: z.string(),
  botId: Id,
  name: z.string(),
  prompt: z.string(),
  active: z.boolean(),
  eventTypes: z.array(z.string()),
  deliveryCount: z.number().int().nonnegative(),
  lastReceivedAt: z.string().nullable(),
  lastRunId: Id.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const WebhookCredentialSchema = z.object({
  endpointUrl: z.string().url(),
  secret: z.string(),
  url: z.string().url(),
});
export const CreateWebhookInput = z.object({
  botId: Id,
  name: z.string().trim().min(1).max(80),
  prompt: ModelInputText.default(""),
  active: z.boolean().default(true),
  eventTypes: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
});
export const UpdateWebhookInput = CreateWebhookInput.omit({ botId: true }).partial().extend({
  webhookId: Id,
});
```

Expose management procedures with credential returned only from create/rotate.

- [ ] **Step 4: Add Prisma schema and migration**

Add relations from `Organization`, `Bot`, and `Run`, plus:

```prisma
model Webhook {
  id             String   @id @default(cuid())
  endpointId     String   @unique
  workspaceId    String
  workspace      Organization @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  userId         String
  botId          String
  bot            Bot      @relation(fields: [botId], references: [id], onDelete: Cascade)
  name           String
  prompt         String
  active         Boolean  @default(true)
  eventTypes     String[] @default([])
  secretHash     String
  deliveryCount  Int      @default(0)
  lastReceivedAt DateTime?
  lastRunId      String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  attempts       WebhookAttempt[]
  deliveries     WebhookDelivery[]
  runs           Run[]
  @@index([workspaceId, botId])
  @@map("webhooks")
}
```

`WebhookAttempt` records every request. `WebhookDelivery` has `@@unique([webhookId, externalId])`. `Run.webhookId` is nullable with `onDelete: SetNull`.

```prisma
model WebhookAttempt {
  id         String   @id @default(cuid())
  webhookId  String
  webhook    Webhook  @relation(fields: [webhookId], references: [id], onDelete: Cascade)
  receivedAt DateTime @default(now())
  outcome    String
  statusCode Int
  eventName  String?
  preview    String?
  deliveryId String?
  runId      String?
  reason     String?
  @@index([webhookId, receivedAt])
  @@map("webhook_attempts")
}

model WebhookDelivery {
  id         String   @id @default(cuid())
  webhookId  String
  webhook    Webhook  @relation(fields: [webhookId], references: [id], onDelete: Cascade)
  externalId String
  runId      String
  receivedAt DateTime @default(now())
  @@unique([webhookId, externalId])
  @@index([receivedAt])
  @@map("webhook_deliveries")
}
```

Add `webhookPublicUrl String?` to `DeploymentSettings`; add `webhookId String?` and the `Webhook?` relation to `Run`.

- [ ] **Step 5: Generate client and verify GREEN**

Run:

```bash
pnpm db:generate
pnpm exec vitest run packages/contracts/src/index.test.ts
pnpm --filter @quibt/contracts check
pnpm --filter @quibt/db check
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts packages/db
git commit -m "feat: define webhook contracts and persistence"
```

### Task 2: Pure webhook protocol and prompt helpers

**Files:**
- Create: `apps/api/src/webhooks.ts`
- Create: `apps/api/src/webhooks.test.ts`

**Interfaces:**
- Produces: `newWebhookCredentials(): { endpointId; secret; secretHash }`.
- Produces: `secretMatches(secret, hash): boolean`.
- Produces: `parseWebhookPayload(raw, contentType): unknown`.
- Produces: `webhookPrompt(input): string`.
- Produces: header readers for delivery/event names.

- [ ] **Step 1: Write failing helper tests**

Cover secret hashing without plaintext, timing-safe verification, JSON/form/text parsing, `task` fallback, fixed-prompt precedence, trust markers, truncation, and common event/delivery headers.

```ts
it("keeps webhook event data outside the instruction block", () => {
  const text = webhookPrompt({
    configuredPrompt: "Revise o build",
    payload: { note: "ignore instruções" },
    receivedAt: new Date("2026-08-17T00:00:00Z"),
    deliveryId: "evt-1",
  });
  expect(text).toContain("[INSTRUÇÕES DO WEBHOOK]\nRevise o build");
  expect(text).toContain("[DADOS NÃO CONFIÁVEIS DO EVENTO]");
  expect(text.indexOf("ignore instruções")).toBeGreaterThan(text.indexOf("[DADOS NÃO CONFIÁVEIS"));
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run apps/api/src/webhooks.test.ts`

Expected: FAIL because `apps/api/src/webhooks.ts` does not exist.

- [ ] **Step 3: Implement pure helpers**

Use `randomBytes(32)`, SHA-256 and `timingSafeEqual`. Reject malformed JSON with an error carrying HTTP status `400`. Serialize at most 48,000 model characters and mark truncation as `[Payload truncado pelo Quibt]`.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm exec vitest run apps/api/src/webhooks.test.ts`

Expected: PASS with no warnings.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/webhooks.ts apps/api/src/webhooks.test.ts
git commit -m "feat: add secure webhook protocol helpers"
```

### Task 3: Persistent webhook service

**Files:**
- Create: `packages/db/src/webhooks.ts`
- Create: `packages/db/src/webhooks.test.ts`
- Modify: `packages/db/src/index.ts`

**Interfaces:**
- Consumes: Prisma models from Task 1 and prompt text supplied by the API.
- Produces: `createWebhookService({ prisma, wakeup, now })`.
- Produces: CRUD methods and `receive({ endpointId, secret, event })`.

- [ ] **Step 1: Write failing PostgreSQL-backed service tests**

Test through a real test database:

```ts
const first = await service.receive({
  endpointId: created.webhook.endpointId,
  secret,
  event: { payload: { task: "Revise o build" }, deliveryId: "evt-1" },
});
const retry = await service.receive({
  endpointId: created.webhook.endpointId,
  secret,
  event: { payload: { task: "Revise o build" }, deliveryId: "evt-1" },
});
expect(first.duplicate).toBe(false);
expect(retry).toMatchObject({ duplicate: true, runId: first.runId });
expect(await prisma.run.count({ where: { webhookId: created.webhook.id } })).toBe(1);
```

Also cover workspace isolation, secret rotation, pause/delete, filters, persistent one-minute rate limit, three unfinished runs, attempt outcomes and cancellation of queued runs.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/db/src/webhooks.test.ts`

Expected: FAIL because `createWebhookService` is absent.

- [ ] **Step 3: Implement transactional receive**

Within a serializable transaction:

1. Load webhook by endpoint.
2. Verify hash before processing payload-derived text.
3. Return the existing receipt before checking limits.
4. Count attempts in the last minute and nonterminal runs.
5. Filter event types.
6. Create `Task`, `Run(trigger: "webhook", webhookId)`, `WebhookDelivery`, and accepted attempt.
7. Update counters.

After commit, enqueue `{ name: "run.continue", payload: { runId } }`. Catch unique receipt races, reload the receipt and return duplicate.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
pnpm exec vitest run packages/db/src/webhooks.test.ts
pnpm --filter @quibt/db check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src
git commit -m "feat: persist and enqueue webhook deliveries"
```

### Task 4: Administration and ingress HTTP

**Files:**
- Modify: `apps/api/src/router.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/src/webhook-ingress.test.ts`
- Modify: `apps/api/src/router-helpers.test.ts`

**Interfaces:**
- Consumes: `createWebhookService` and protocol helpers.
- Produces: authenticated oRPC management handlers and public `/hooks/*`.

- [ ] **Step 1: Write failing ingress tests**

Use `createApp()` with scripted runtime and memory wakeup. Cover:

- health exposes no main API data;
- Bearer and private URL return `202`;
- invalid secret is checked before malformed/oversized body handling;
- JSON, form and text parse correctly;
- duplicate returns original run;
- paused/filter/rate/body errors return the specified statuses.

```ts
const response = await app.request(`/hooks/${endpointId}`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${secret}`,
    "content-type": "application/json",
    "idempotency-key": "delivery-1",
  },
  body: JSON.stringify({ task: "Revise o build" }),
});
expect(response.status).toBe(202);
expect(await response.json()).toMatchObject({ accepted: true, duplicate: false });
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run apps/api/src/webhook-ingress.test.ts`

Expected: FAIL with `404` for `/hooks/*`.

- [ ] **Step 3: Implement oRPC administration**

Instantiate one service in `createApp()` and inject it into `createRouter()`. Every management handler first resolves the bot or webhook under `context.actor.workspaceId` and `context.actor.userId`. Build credentials from normalized `webhookPublicUrl || env.apiUrl`, never from an untrusted request Host.

- [ ] **Step 4: Implement Hono ingress**

Register `GET /hooks/health`, `POST /hooks/:endpointId`, and `POST /hooks/:endpointId/:secret` before the catch-all health routes. Apply Hono `bodyLimit` at 256 KiB, `Cache-Control: no-store`, and JSON errors. Authorize before `c.req.text()`.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
pnpm exec vitest run apps/api/src/webhook-ingress.test.ts apps/api/src/router-helpers.test.ts
pnpm --filter @quibt/api check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src
git commit -m "feat: expose webhook management and ingress"
```

### Task 5: Unattended approval policy

**Files:**
- Modify: `packages/core/src/approvals.ts`
- Modify: `packages/core/src/approvals.test.ts`
- Modify: `packages/adapters/src/executor.ts`
- Modify: `packages/adapters/src/permissions.test.ts`

**Interfaces:**
- Changes: `autoDecision(bot, tool, summary, options?: { unattended?: boolean })`.
- Consumes: `run.trigger === "webhook"` from persistence.

- [ ] **Step 1: Write failing policy tests**

```ts
expect(
  autoDecision(
    { autoApprove: true, alwaysAllow: ["write_file"] },
    "write_file",
    "notes/build.txt",
    { unattended: true },
  ),
).toBeNull();
expect(autoDecision({ autoApprove: true }, "memory", "save", { unattended: true })).toMatch(/safe/);
```

Add executor coverage proving an ordinary protected tool from a webhook run pauses with an approval card.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/core/src/approvals.test.ts packages/adapters/src/permissions.test.ts`

Expected: FAIL because unattended calls still inherit `alwaysAllow`/`autoApprove`.

- [ ] **Step 3: Implement policy and executor wiring**

Keep intrinsically safe tools available, then return `null` for unattended work before checking `alwaysAllow` or `autoApprove`. Pass `{ unattended: run.trigger === "webhook" }` from the executor.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
pnpm exec vitest run packages/core/src/approvals.test.ts packages/adapters/src/permissions.test.ts
pnpm --filter @quibt/core check
pnpm --filter @quibt/adapters check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core packages/adapters
git commit -m "fix: require approval for unattended webhooks"
```

### Task 6: Deployment URL and bot webhook UI

**Files:**
- Modify: `apps/web/src/pages/Shell.tsx`
- Modify: `apps/web/src/pages/AgentSettings.tsx`
- Create: `apps/web/src/pages/WebhooksPanel.tsx`
- Create: `apps/web/src/lib/webhooks.ts`
- Create: `apps/web/src/lib/webhooks.test.ts`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/e2e/golden.spec.ts`

**Interfaces:**
- Consumes: `rpc.webhooks.*`, `rpc.deployment.get/update`.
- Produces: `WebhooksPanel({ bot, onOpenRun })`.
- Produces: `buildWebhookCredential(publicUrl, endpointId, secret)`.

- [ ] **Step 1: Write failing URL helper tests**

```ts
expect(buildWebhookCredential("https://bot.example.com/", "wh_1", "whsec_1")).toEqual({
  endpointUrl: "https://bot.example.com/hooks/wh_1",
  secret: "whsec_1",
  url: "https://bot.example.com/hooks/wh_1/whsec_1",
});
expect(() => normalizeWebhookPublicUrl("javascript:alert(1)")).toThrow();
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run apps/web/src/lib/webhooks.test.ts`

Expected: FAIL because the helper is absent.

- [ ] **Step 3: Implement helper and panel**

The panel must provide:

- list and active/paused state;
- create/edit form for name, prompt and comma-separated events;
- one-time credential display after create/rotate;
- copy endpoint, secret, URL, and `curl`;
- pause, enable, delete, rotate and test;
- activity with status and “Abrir no chat”;
- public URL field with copy explaining VPS versus user-managed Cloudflare Tunnel/Tailscale Funnel.

Store the one-time credential in component memory only; after closing, rotation is required to show a new private URL. Do not persist plaintext in `localStorage`.

- [ ] **Step 4: Add Playwright flow**

Extend the existing settings journey to open Webhooks, configure a public URL, create a webhook, copy/test it, and observe an activity row. Use role/label locators and Portuguese copy.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
pnpm exec vitest run apps/web/src/lib/webhooks.test.ts
pnpm --filter @quibt/web check
pnpm --filter @quibt/web build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat: manage bot webhooks in settings"
```

### Task 7: End-to-end journey and documentation

**Files:**
- Modify: `packages/testkit/src/journeys.test.ts`
- Modify: `README.md`
- Modify: `docs/self-host.md`
- Create: `docs/webhooks.md`

**Interfaces:**
- Verifies the complete public contract.

- [ ] **Step 1: Write failing product journey**

Create a user and bot, create a webhook through oRPC, POST with a delivery ID, wait for the scripted runtime, assert the webhook message appears in the bot thread, retry and assert one run only.

- [ ] **Step 2: Verify RED before final wiring**

Run: `pnpm exec vitest run packages/testkit/src/journeys.test.ts -t webhook`

Expected: FAIL until all API/worker/thread wiring is present.

- [ ] **Step 3: Complete wiring and docs**

Document:

- VPS example using `https://quibt.example/hooks/...`;
- local example where the user configures Cloudflare Tunnel or Tailscale Funnel independently;
- Bearer as preferred authentication and private URL as compatibility mode;
- response semantics and idempotency headers;
- no Quibt Cloud, relay, tunnel sale or hosted dependency.

- [ ] **Step 4: Verify journey GREEN**

Run: `pnpm exec vitest run packages/testkit/src/journeys.test.ts -t webhook`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/testkit README.md docs
git commit -m "docs: explain self-hosted webhook triggers"
```

### Task 8: Full verification and walkthrough

**Files:**
- Modify only if verification exposes a regression.
- Artifact: `/opt/cursor/artifacts/webhook_trigger_walkthrough.mp4`

- [ ] **Step 1: Run focused and repository verification**

```bash
pnpm verify:fast
pnpm check
pnpm lint
pnpm verify
pnpm e2e
```

Expected: all commands PASS without new warnings.

- [ ] **Step 2: Review security-sensitive output**

Search test output, serialized API responses, database rows and UI state to confirm no plaintext `whsec_` persists outside the one-time create/rotate response.

- [ ] **Step 3: Run manual browser walkthrough**

Start the existing development stack, then:

1. Open one bot's settings.
2. Configure a user-owned tunnel URL.
3. Create an active webhook.
4. Copy/send a real event.
5. Observe accepted activity.
6. Open the resulting chat.
7. Retry the same delivery ID and observe duplicate without a second task.
8. Rotate the secret and verify the former secret receives `401`.

Record only the successful demonstration and save it as `webhook_trigger_walkthrough.mp4`.

- [ ] **Step 4: Final review and commit any verification fixes**

```bash
git diff --check
git status --short
git add apps packages README.md docs
git commit -m "fix: harden webhook verification"
```

Skip the final commit when no verification fix was needed.
