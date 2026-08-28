import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "@quibt/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESTROY_BATCH_SIZE, finalizeBotDestroyAfterProvider } from "./bot-destroy-finalize.js";
import { spawnBot } from "./child-bots.js";
import {
  type LifecycleIntentRow,
  recordLifecycleCleanupIntent,
  resolveLifecycleCleanupIntent,
  validateLifecycleCleanupIntent,
} from "./lifecycle-cleanup-intent.js";
import { claimDesktopDelete, cleanupIntentReason } from "./session-lifecycle.js";

function loadDatabaseUrl() {
  const file = path.resolve(".env");
  if (!existsSync(file) || process.env.DATABASE_URL) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    if (trimmed.slice(0, eq) !== "DATABASE_URL") continue;
    process.env.DATABASE_URL = trimmed.slice(eq + 1);
    return;
  }
}

loadDatabaseUrl();

const hasDb = Boolean(process.env.DATABASE_URL);
const describeSpawn = hasDb ? describe : describe.skip;

/**
 * `spawnBot`'s duplicate-retry path is covered against a hand-written Prisma fake in
 * `child-bots.test.ts`; the fresh-creation path goes through `createRepos().createBot`
 * (transaction, bot count, thread, computer, desktop session, memory doc, default
 * conversation), which is not worth re-implementing by hand. This drives the real database
 * to prove the spawned child's first run keeps the ordinary "spawn" trigger while still
 * carrying a webhook origin (if any) in `webhookId`.
 */
describeSpawn("spawnBot run trigger and webhook origin", () => {
  let db: ReturnType<typeof createDb>;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const workspaceId = `ws-spawn-${stamp}`;
  const userId = `user-spawn-${stamp}`;
  let parentBotId: string;
  let webhookId: string;

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    await db.prisma.organization.create({
      data: {
        id: workspaceId,
        name: "Spawn workspace",
        slug: `spawn-${stamp}`,
        createdAt: new Date(),
      },
    });
    const parent = await db.prisma.bot.create({
      data: { workspaceId, userId, name: "Chief", color: "#123456" },
    });
    parentBotId = parent.id;
    // `Run.webhookId` is a real foreign key, so propagating a webhook origin in these tests
    // needs an actual Webhook row to point at, not just a string.
    const webhook = await db.prisma.webhook.create({
      data: {
        endpointId: `wh_spawn_${stamp}`,
        workspaceId,
        userId,
        botId: parentBotId,
        name: "Origin webhook",
        prompt: "",
        secretHash: "fake-hash",
      },
    });
    webhookId = webhook.id;
  });

  afterAll(async () => {
    await db.prisma.organization.delete({ where: { id: workspaceId } }).catch(() => undefined);
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("gives the spawned child's first run the ordinary spawn trigger and no webhookId by default", async () => {
    const result = await spawnBot(
      { prisma: db.prisma },
      {
        spawnedBy: { id: parentBotId, name: "Chief", workspaceId, userId },
        runId: "seed-run-1",
        name: "Helper A",
        prompt: "Start the assigned work",
      },
    );
    if ("error" in result) throw new Error(result.error);
    const run = await db.prisma.run.findFirstOrThrow({ where: { botId: result.botId } });
    expect(run.trigger).toBe("spawn");
    expect(run.webhookId).toBeNull();
  });

  it("keeps the ordinary spawn trigger but carries the webhook origin into webhookId when asked to", async () => {
    const result = await spawnBot(
      { prisma: db.prisma },
      {
        spawnedBy: { id: parentBotId, name: "Chief", workspaceId, userId },
        runId: "seed-run-2",
        name: "Helper B",
        prompt: "Start the assigned work",
        webhookId,
      },
    );
    if ("error" in result) throw new Error(result.error);
    const run = await db.prisma.run.findFirstOrThrow({ where: { botId: result.botId } });
    // Trigger stays "spawn": only the causal origin, not the immediate cause, propagates.
    expect(run.trigger).toBe("spawn");
    expect(run.webhookId).toBe(webhookId);
  });
});

/**
 * A exclusão de bot precisa ser RETOMÁVEL num banco de verdade.
 *
 * O caminho antigo encerrava a sessão ("deleting" -> "stopped", token e providerRef
 * apagados) ANTES de esvaziar o histórico e de rodar a transação final. Uma falha no meio
 * deixava a intent pendente sem retomada possível: `validateLifecycleCleanupIntent` exige
 * estado "deleting" com o MESMO token, então o reconciliador cancelava e o bot ficava meio
 * apagado. Estes dois testes derrubam o banco no meio (um lote e a transação final) e
 * provam, contra Postgres, que o retry termina o serviço.
 */
describeSpawn("destroy is resumable after a mid-flight failure", () => {
  let db: ReturnType<typeof createDb>;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const workspaces: string[] = [];
  const home = {} as never;
  const dataDir = path.join(os.tmpdir(), `quibt-destroy-${stamp}`);

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    for (const workspaceId of workspaces) {
      await db.prisma.organization.delete({ where: { id: workspaceId } }).catch(() => undefined);
    }
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  /** Bot com computador, sessão, tarefa e histórico grande o bastante para vários lotes. */
  async function createDestroyFixture(label: string, runCount: number) {
    const suffix = `${label}-${stamp}`;
    const workspaceId = `ws-destroy-${suffix}`;
    const userId = `user-destroy-${suffix}`;
    workspaces.push(workspaceId);
    await db.prisma.organization.create({
      data: {
        id: workspaceId,
        name: "Destroy workspace",
        slug: `destroy-${suffix}`,
        createdAt: new Date(),
      },
    });
    const bot = await db.prisma.bot.create({
      data: { workspaceId, userId, name: "Doomed", color: "#123456" },
    });
    const computer = await db.prisma.computer.create({
      data: { workspaceId, userId, kind: "box", providerRef: "legacy-box", state: "running" },
    });
    await db.prisma.desktopSession.create({
      data: {
        workspaceId,
        computerId: computer.id,
        botId: bot.id,
        display: 10,
        providerRef: `box-${suffix}`,
        state: "running",
      },
    });
    const thread = await db.prisma.thread.create({ data: { workspaceId, botId: bot.id, userId } });
    const task = await db.prisma.task.create({
      data: {
        workspaceId,
        botId: bot.id,
        threadId: thread.id,
        userId,
        prompt: "work",
        status: "done",
      },
    });
    await db.prisma.run.createMany({
      data: Array.from({ length: runCount }, () => ({
        workspaceId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId,
        status: "done",
        trigger: "user",
      })),
    });

    const claim = await claimDesktopDelete(db.prisma, bot.id);
    if (!claim) throw new Error("delete claim failed");
    const ref = {
      id: `box-${suffix}`,
      botId: bot.id,
      kind: "box" as const,
      providerRef: `box-${suffix}`,
    };
    await recordLifecycleCleanupIntent(db.prisma, {
      ref,
      action: "destroy:delete",
      lifecycleToken: claim.token,
      sessionBotId: bot.id,
      workspaceId,
      reason: cleanupIntentReason("destroy:delete"),
    });
    const intentRow = (await db.prisma.orphanProvision.findFirstOrThrow({
      where: { workspaceId, sessionBotId: bot.id, lifecycleAction: "destroy:delete" },
    })) as unknown as LifecycleIntentRow;

    return {
      workspaceId,
      botId: bot.id,
      computerId: computer.id,
      intentRow,
      input: {
        botId: bot.id,
        workspaceId,
        claimToken: claim.token,
        restoreState: "running",
        computer: { id: computer.id, kind: "box" },
        dataDir,
      },
    };
  }

  /** Um cliente Prisma real com um método trocado, para derrubar um passo escolhido. */
  function withOverrides<T extends object>(client: T, overrides: Record<string, unknown>): T {
    return new Proxy(client, {
      get(target, prop) {
        if (typeof prop === "string" && prop in overrides) return overrides[prop];
        const value = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  it("keeps the deleting claim after a failed history batch and finishes on retry", async () => {
    const fixture = await createDestroyFixture("batch", DESTROY_BATCH_SIZE + 100);
    let batches = 0;
    const flaky = withOverrides(db.prisma, {
      run: {
        findMany: (args: never) => db.prisma.run.findMany(args),
        deleteMany: async (args: never) => {
          batches += 1;
          if (batches === 2) throw new Error("connection lost mid-purge");
          return db.prisma.run.deleteMany(args);
        },
      },
    });

    await expect(
      finalizeBotDestroyAfterProvider({ prisma: flaky, home, dataDir }, fixture.input),
    ).rejects.toThrow("connection lost mid-purge");

    // Meio apagado no banco de verdade: um lote saiu, o resto ficou.
    expect(await db.prisma.run.count({ where: { botId: fixture.botId } })).toBe(100);
    const session = await db.prisma.desktopSession.findUniqueOrThrow({
      where: { botId: fixture.botId },
    });
    expect(session.state).toBe("deleting");
    expect(session.bootClaimToken).toBe(fixture.input.claimToken);
    expect(session.providerRef).toBe(fixture.intentRow.refSnapshotProviderRef);
    // O que prova a retomada: a intent pendente ainda é válida, não "stale".
    await expect(validateLifecycleCleanupIntent(db.prisma, fixture.intentRow)).resolves.toEqual({
      ok: true,
      action: "destroy:delete",
    });

    // Retry de verdade, com o banco são.
    expect(
      await finalizeBotDestroyAfterProvider({ prisma: db.prisma, home, dataDir }, fixture.input),
    ).toBe(true);
    expect(await db.prisma.bot.findUnique({ where: { id: fixture.botId } })).toBeNull();
    expect(await db.prisma.run.count({ where: { botId: fixture.botId } })).toBe(0);
    expect(await db.prisma.task.count({ where: { botId: fixture.botId } })).toBe(0);
    expect(
      await db.prisma.desktopSession.findUnique({ where: { botId: fixture.botId } }),
    ).toBeNull();
  });

  it("rolls the closing transaction back and finishes on retry", async () => {
    const fixture = await createDestroyFixture("final-tx", 3);
    const flaky = withOverrides(db.prisma, {
      $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
        db.prisma.$transaction((tx) =>
          fn(
            withOverrides(tx, {
              bot: {
                delete: async () => {
                  throw new Error("closing transaction failed");
                },
              },
            }),
          ),
        ),
    });

    await expect(
      finalizeBotDestroyAfterProvider({ prisma: flaky, home, dataDir }, fixture.input),
    ).rejects.toThrow("closing transaction failed");

    // A transação foi desfeita: a sessão continua lá, com a MESMA marca de exclusão.
    const session = await db.prisma.desktopSession.findUniqueOrThrow({
      where: { botId: fixture.botId },
    });
    expect(session.state).toBe("deleting");
    expect(session.bootClaimToken).toBe(fixture.input.claimToken);
    expect(await db.prisma.bot.findUnique({ where: { id: fixture.botId } })).not.toBeNull();
    expect(await db.prisma.run.count({ where: { botId: fixture.botId } })).toBe(0);
    await expect(validateLifecycleCleanupIntent(db.prisma, fixture.intentRow)).resolves.toEqual({
      ok: true,
      action: "destroy:delete",
    });

    expect(
      await finalizeBotDestroyAfterProvider({ prisma: db.prisma, home, dataDir }, fixture.input),
    ).toBe(true);
    expect(await db.prisma.bot.findUnique({ where: { id: fixture.botId } })).toBeNull();
    expect(
      await db.prisma.desktopSession.findUnique({ where: { botId: fixture.botId } }),
    ).toBeNull();
    expect(await db.prisma.computer.findUnique({ where: { id: fixture.computerId } })).toBeNull();
    expect(
      await resolveLifecycleCleanupIntent(db.prisma, {
        workspaceId: fixture.workspaceId,
        sessionBotId: fixture.botId,
        lifecycleAction: "destroy:delete",
        lifecycleToken: fixture.input.claimToken,
      }),
    ).toBe(true);
  });
});
