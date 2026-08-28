import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  MemoryCommitRequest,
  MemoryRevision,
  MemorySnapshot,
} from "@quibt/adapter-kit";
import { createDb, fitLiveProgressPayload } from "@quibt/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRunExecutor } from "./executor.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";
import { InMemoryWakeupDriver } from "./wakeup.js";

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
const describeProgress = hasDb ? describe : describe.skip;

/** No memory documents to read or write; continueRun only needs the shape, not real content. */
class NullMemoryStore {
  describe() {
    return {
      id: "null",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { search: false, revisions: false, markdownPortable: false },
    };
  }
  async read(): Promise<MemorySnapshot> {
    return { documents: [] };
  }
  async search() {
    return [];
  }
  async commit(request: MemoryCommitRequest): Promise<MemoryRevision> {
    return { id: "noop", path: request.path, revision: 1, content: request.content };
  }
  async *exportMarkdown(): AsyncIterable<never> {}
  async importMarkdown(): Promise<MemoryRevision> {
    return { id: "noop", path: "", revision: 1, content: "" };
  }
}

/**
 * Streams the answer the way a real provider does. Non-scripted, so the executor takes the
 * live `thread.progress` path that sends the accumulated text through `pg_notify`.
 */
class StreamingRuntime implements AgentRuntime {
  chunks: string[] = [];

  describe() {
    return {
      id: "streaming-fake",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
    };
  }

  async abort(): Promise<void> {}

  async *run(
    _request: AgentRunRequest,
    _context: AdapterContext,
  ): AsyncIterable<AgentRuntimeEvent> {
    for (const chunk of this.chunks) yield { type: "text", text: chunk };
    yield { type: "done", text: "" };
  }
}

/**
 * Postgres refuses a NOTIFY payload of 8000 bytes or more. Streaming sends the whole answer
 * so far on every tick, so a long reply used to raise 22023 mid-run, the executor's catch
 * failed the run, and the person read a raw Prisma error instead of the answer.
 */
describeProgress("live progress on a long answer (real Postgres)", () => {
  let db: ReturnType<typeof createDb>;
  let executor: ReturnType<typeof createRunExecutor>;
  let runtime: StreamingRuntime;
  let wakeup: InMemoryWakeupDriver;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const workspaceId = `ws-progress-${stamp}`;
  const userId = `user-progress-${stamp}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-progress-"));

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    await db.prisma.organization.create({
      data: {
        id: workspaceId,
        name: "Progress workspace",
        slug: `progress-${stamp}`,
        createdAt: new Date(),
      },
    });
    runtime = new StreamingRuntime();
    wakeup = new InMemoryWakeupDriver();
    executor = createRunExecutor({
      prisma: db.prisma,
      runtime,
      sandbox: new FakeSandboxProvider(),
      memory: new NullMemoryStore() as never,
      home: new LocalAgentHomeStore(dataDir),
      secrets: [],
      dataDir,
      wakeup,
      deploymentModelKey: "test-model-key",
    });
  });

  afterAll(async () => {
    await wakeup.stop();
    await db.prisma.organization.delete({ where: { id: workspaceId } }).catch(() => undefined);
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function newBotWithComputer(name: string) {
    const bot = await db.prisma.bot.create({
      data: { workspaceId, userId, name, color: "#123456", autoApprove: true },
    });
    const thread = await db.prisma.thread.create({
      data: { workspaceId, userId, botId: bot.id },
    });
    const computer = await db.prisma.computer.upsert({
      where: { workspaceId },
      create: { workspaceId, userId, kind: "fake", state: "stopped" },
      update: {},
    });
    const lastSession = await db.prisma.desktopSession.findFirst({
      where: { computerId: computer.id },
      orderBy: { display: "desc" },
      select: { display: true },
    });
    await db.prisma.desktopSession.create({
      data: {
        workspaceId,
        computerId: computer.id,
        botId: bot.id,
        display: (lastSession?.display ?? 0) + 1,
        state: "stopped",
        controlHolder: "bot",
      },
    });
    return { bot, thread };
  }

  async function newRun(input: { botId: string; threadId: string }) {
    const task = await db.prisma.task.create({
      data: {
        workspaceId,
        botId: input.botId,
        threadId: input.threadId,
        userId,
        prompt: "escreva um relatório longo",
        status: "queued",
      },
    });
    return db.prisma.run.create({
      data: {
        workspaceId,
        botId: input.botId,
        threadId: input.threadId,
        taskId: task.id,
        userId,
        status: "queued",
        trigger: "user",
      },
    });
  }

  async function answerOf(threadId: string) {
    const message = await db.prisma.message.findFirstOrThrow({
      where: { threadId, role: "bot" },
      orderBy: { seq: "desc" },
    });
    return (message.blocks as Array<{ kind: string; text: string }>)[0]!;
  }

  it("survives an ASCII answer above 9 KB and keeps the final message whole", async () => {
    const { bot, thread } = await newBotWithComputer("Long ASCII");
    const run = await newRun({ botId: bot.id, threadId: thread.id });
    const answer = "the quick brown fox jumps over the lazy dog. ".repeat(210);
    expect(Buffer.byteLength(answer, "utf8")).toBeGreaterThan(9_000);
    runtime.chunks = [answer];

    await executor.continueRun(run.id, "worker-progress");

    const after = await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("completed");
    expect(after.error).toBeNull();
    expect(await answerOf(thread.id)).toEqual({ kind: "text", text: answer });
  });

  it("survives a multibyte answer above 9 KB and keeps the final message whole", async () => {
    const { bot, thread } = await newBotWithComputer("Long multibyte");
    const run = await newRun({ botId: bot.id, threadId: thread.id });
    const answer = "ação, coração e emoção 🙂 — relatório detalhado.\n".repeat(180);
    expect(Buffer.byteLength(answer, "utf8")).toBeGreaterThan(9_000);
    runtime.chunks = [answer];

    await executor.continueRun(run.id, "worker-progress");

    const after = await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("completed");
    expect(after.error).toBeNull();
    expect(await answerOf(thread.id)).toEqual({ kind: "text", text: answer });
  });

  it("fits a live tick well above the limit into a payload Postgres accepts", async () => {
    // Straight at pg_notify, with no catch in the way: this is the query that used to fail
    // with 22023 and take the run with it.
    const payload = fitLiveProgressPayload({
      workspaceId,
      threadId: `thread-${stamp}`,
      type: "thread.progress",
      payload: { text: "ó🙂".repeat(4_000), streaming: true },
    });
    expect(payload).toBeTruthy();
    expect(Buffer.byteLength(payload!, "utf8")).toBeLessThan(8_000);
    await expect(
      db.prisma.$executeRaw`SELECT pg_notify('quibt_events', ${payload!})`,
    ).resolves.toBe(1);
  });
});
