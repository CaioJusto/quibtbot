import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createRunExecutor,
  FakeSandboxProvider,
  InMemoryWakeupDriver,
  LocalAgentHomeStore,
  ScriptedAgentRuntime,
} from "@quibt/adapters";
import { createDb } from "@quibt/db";
import { MarkdownMemoryStore } from "@quibt/memory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const hasDb = Boolean(process.env.DATABASE_URL);
const describeControl = hasDb ? describe : describe.skip;

/**
 * Booting the computer must not cancel a takeover. This drives the real executor against the
 * real database, because the bug was a single unconditional column write inside a transaction.
 */
describeControl("a run that boots the computer and a live takeover", () => {
  let db: ReturnType<typeof createDb>;
  let executor: ReturnType<typeof createRunExecutor>;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const workspaceId = `ws-control-${stamp}`;
  const userId = `user-control-${stamp}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-control-"));
  let bots = 0;

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    await db.prisma.organization.create({
      data: {
        id: workspaceId,
        name: "Control workspace",
        slug: `control-${stamp}`,
        createdAt: new Date(),
      },
    });
    executor = createRunExecutor({
      prisma: db.prisma,
      runtime: new ScriptedAgentRuntime(),
      sandbox: new FakeSandboxProvider(),
      memory: new MarkdownMemoryStore(db.prisma),
      home: new LocalAgentHomeStore(dataDir),
      secrets: [],
      dataDir,
      wakeup: new InMemoryWakeupDriver(),
    });
  });

  afterAll(async () => {
    await db.prisma.organization.delete({ where: { id: workspaceId } }).catch(() => undefined);
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  /** A bot with everything `ensureComputer` needs: a computer and its desktop session. */
  async function newBotWithComputer(control: {
    controlHolder: string;
    controlLeaseId?: string | null;
    controlLeaseUserId?: string | null;
    controlLeaseExpiresAt?: Date | null;
  }) {
    bots += 1;
    const bot = await db.prisma.bot.create({
      data: { workspaceId, userId, name: `Control ${bots}`, color: "#123456" },
    });
    const thread = await db.prisma.thread.create({
      data: { workspaceId, userId, botId: bot.id },
    });
    const computer = await db.prisma.computer.upsert({
      where: { workspaceId },
      create: { workspaceId, userId, kind: "fake", state: "stopped" },
      update: {},
    });
    await db.prisma.desktopSession.create({
      data: {
        workspaceId,
        computerId: computer.id,
        botId: bot.id,
        display: bots,
        state: "stopped",
        controlHolder: control.controlHolder,
        controlLeaseId: control.controlLeaseId ?? null,
        controlLeaseUserId: control.controlLeaseUserId ?? null,
        controlLeaseExpiresAt: control.controlLeaseExpiresAt ?? null,
        controlFence: control.controlHolder === "user" ? 1 : 0,
      },
    });
    return { bot, thread };
  }

  /** A queued run whose scripted turn writes a file, which is what boots the computer. */
  async function runThatUsesTheComputer(botId: string, threadId: string) {
    const prompt = "write a file in your home called notes/result.txt that says control-ok";
    const task = await db.prisma.task.create({
      data: { workspaceId, botId, threadId, userId, prompt, status: "queued" },
    });
    return db.prisma.run.create({
      data: {
        workspaceId,
        botId,
        threadId,
        taskId: task.id,
        userId,
        status: "queued",
        trigger: "user",
      },
    });
  }

  it("leaves the keyboard with the member and still boots the computer", async () => {
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    const { bot, thread } = await newBotWithComputer({
      controlHolder: "user",
      controlLeaseId: "ctl_live",
      controlLeaseUserId: userId,
      controlLeaseExpiresAt: expiresAt,
    });
    const run = await runThatUsesTheComputer(bot.id, thread.id);

    await executor.continueRun(run.id, "worker-control");

    const session = await db.prisma.desktopSession.findUniqueOrThrow({ where: { botId: bot.id } });
    expect(session.controlHolder).toBe("user");
    expect(session.controlLeaseId).toBe("ctl_live");
    expect(session.controlLeaseUserId).toBe(userId);
    expect(session.controlLeaseExpiresAt?.getTime()).toBe(expiresAt.getTime());
    // Everything that is not about control still happened: the computer really booted.
    expect(session.state).toBe("running");
    expect(session.providerRef).toBeTruthy();
    expect((await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
      "completed",
    );
  });

  it("takes the computer back when the takeover has expired", async () => {
    const { bot, thread } = await newBotWithComputer({
      controlHolder: "user",
      controlLeaseId: "ctl_stale",
      controlLeaseUserId: userId,
      controlLeaseExpiresAt: new Date(Date.now() - 60_000),
    });
    const run = await runThatUsesTheComputer(bot.id, thread.id);

    await executor.continueRun(run.id, "worker-control");

    const session = await db.prisma.desktopSession.findUniqueOrThrow({ where: { botId: bot.id } });
    expect(session.controlHolder).toBe("bot");
    expect(session.controlLeaseId).toBeNull();
    expect(session.controlLeaseUserId).toBeNull();
    expect(session.controlLeaseExpiresAt).toBeNull();
    expect(session.state).toBe("running");
  });

  it("keeps taking control when nobody is at the screen", async () => {
    const { bot, thread } = await newBotWithComputer({ controlHolder: "none" });
    const run = await runThatUsesTheComputer(bot.id, thread.id);

    await executor.continueRun(run.id, "worker-control");

    const session = await db.prisma.desktopSession.findUniqueOrThrow({ where: { botId: bot.id } });
    expect(session.controlHolder).toBe("bot");
    expect(session.state).toBe("running");
    expect(session.providerRef).toBeTruthy();
  });
});
