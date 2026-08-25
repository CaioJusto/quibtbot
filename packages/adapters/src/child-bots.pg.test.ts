import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createDb } from "@quibt/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnBot } from "./child-bots.js";

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
