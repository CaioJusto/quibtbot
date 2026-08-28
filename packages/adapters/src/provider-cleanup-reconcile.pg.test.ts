import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "@quibt/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SupervisorRequestError } from "./docker-sandbox.js";
import { recordLifecycleCleanupIntent } from "./lifecycle-cleanup-intent.js";
import { reconcilePendingProviderCleanups } from "./provider-cleanup-reconcile.js";
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
const describeDb = hasDb ? describe : describe.skip;

/**
 * As duas pontas da exclusão retomável, contra o banco de verdade.
 *
 * O retry cai sobre um providerRef que a passada anterior já apagou (o provedor responde
 * "não existe"), e o processo pode morrer entre a transação final e o `resolve` da intent.
 * Nos dois casos a intent tem de FECHAR; com o bot vivo, nunca.
 */
describeDb("provider cleanup reconciler closes resumed destroys", () => {
  let db: ReturnType<typeof createDb>;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const workspaces: string[] = [];
  const home = {} as never;
  const dataDir = path.join(os.tmpdir(), `quibt-reconcile-${stamp}`);

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

  /** Bot com computador, sessão marcada para exclusão e intent pendente. */
  async function createPendingDestroy(label: string) {
    const suffix = `${label}-${stamp}`;
    const workspaceId = `ws-reconcile-${suffix}`;
    const userId = `user-reconcile-${suffix}`;
    workspaces.push(workspaceId);
    await db.prisma.organization.create({
      data: {
        id: workspaceId,
        name: "Reconcile workspace",
        slug: `reconcile-${suffix}`,
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
        display: 11,
        providerRef: `box-${suffix}`,
        state: "running",
      },
    });
    const claim = await claimDesktopDelete(db.prisma, bot.id);
    if (!claim) throw new Error("delete claim failed");
    await recordLifecycleCleanupIntent(db.prisma, {
      ref: { id: `box-${suffix}`, botId: bot.id, kind: "box", providerRef: `box-${suffix}` },
      action: "destroy:delete",
      lifecycleToken: claim.token,
      sessionBotId: bot.id,
      workspaceId,
      reason: cleanupIntentReason("destroy:delete"),
    });
    return { workspaceId, botId: bot.id, computerId: computer.id };
  }

  function intentStatus(workspaceId: string, botId: string) {
    return db.prisma.orphanProvision
      .findFirstOrThrow({
        where: { workspaceId, sessionBotId: botId, lifecycleAction: "destroy:delete" },
      })
      .then((row) => row.status);
  }

  it("resolves the retry when the provider answers not-found for an already destroyed ref", async () => {
    const fixture = await createPendingDestroy("gone");
    const destroyBotSession = vi.fn(async () => {
      // Segunda passada sobre um ref que já saiu: é assim que Docker/supervisor responde.
      throw new SupervisorRequestError("destroy", 404);
    });
    const resolved = await reconcilePendingProviderCleanups(
      { prisma: db.prisma, sandbox: { destroyBotSession } as never, home, dataDir },
      { workspaceId: fixture.workspaceId },
    );
    expect(resolved).toBe(1);
    expect(destroyBotSession).toHaveBeenCalledOnce();
    expect(await intentStatus(fixture.workspaceId, fixture.botId)).toBe("resolved");
    expect(await db.prisma.bot.findUnique({ where: { id: fixture.botId } })).toBeNull();
    expect(
      await db.prisma.desktopSession.findUnique({ where: { botId: fixture.botId } }),
    ).toBeNull();
  });

  it("keeps the intent pending when the provider fails for real", async () => {
    const fixture = await createPendingDestroy("down");
    const destroyBotSession = vi.fn(async () => {
      throw new SupervisorRequestError("destroy", 503, JSON.stringify({ code: "docker-down" }));
    });
    const resolved = await reconcilePendingProviderCleanups(
      { prisma: db.prisma, sandbox: { destroyBotSession } as never, home, dataDir },
      { workspaceId: fixture.workspaceId },
    );
    expect(resolved).toBe(0);
    expect(await intentStatus(fixture.workspaceId, fixture.botId)).toBe("pending");
    // A marca de exclusão continua de pé: o próximo retry retoma.
    const session = await db.prisma.desktopSession.findUnique({ where: { botId: fixture.botId } });
    expect(session?.state).toBe("deleting");
  });

  it("resolves an intent whose bot and session vanished between the transaction and the resolve", async () => {
    const fixture = await createPendingDestroy("crash");
    // O que a transação final já tinha commitado quando o processo morreu.
    await db.prisma.desktopSession.delete({ where: { botId: fixture.botId } });
    await db.prisma.bot.delete({ where: { id: fixture.botId } });
    const destroyBotSession = vi.fn(async () => undefined);
    const resolved = await reconcilePendingProviderCleanups(
      { prisma: db.prisma, sandbox: { destroyBotSession } as never, home, dataDir },
      { workspaceId: fixture.workspaceId },
    );
    expect(resolved).toBe(1);
    expect(destroyBotSession).not.toHaveBeenCalled();
    expect(await intentStatus(fixture.workspaceId, fixture.botId)).toBe("resolved");
  });

  it("never resolves an intent while the bot is still alive", async () => {
    const fixture = await createPendingDestroy("alive");
    await db.prisma.desktopSession.delete({ where: { botId: fixture.botId } });
    const destroyBotSession = vi.fn(async () => undefined);
    const resolved = await reconcilePendingProviderCleanups(
      { prisma: db.prisma, sandbox: { destroyBotSession } as never, home, dataDir },
      { workspaceId: fixture.workspaceId },
    );
    expect(resolved).toBe(0);
    expect(destroyBotSession).not.toHaveBeenCalled();
    expect(await intentStatus(fixture.workspaceId, fixture.botId)).toBe("pending");
    expect(await db.prisma.bot.findUnique({ where: { id: fixture.botId } })).not.toBeNull();
  });
});
