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
import { parseRunCheckpoint } from "@quibt/core";
import { createDb } from "@quibt/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApprovalPause, approvalCheckpoint } from "./approval-wait.js";
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
const describeUnattended = hasDb ? describe : describe.skip;

/** No memory documents to read or write; continueRun only needs the shape, not real content. */
class NullMemoryStore {
  describe() {
    return {
      id: "null",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        search: false,
        revisions: false,
        markdownPortable: false,
      },
    };
  }
  async read(): Promise<MemorySnapshot> {
    return { documents: [] };
  }
  async search() {
    return [];
  }
  async commit(request: MemoryCommitRequest): Promise<MemoryRevision> {
    return {
      id: "noop",
      path: request.path,
      revision: 1,
      content: request.content,
    };
  }
  async *exportMarkdown(): AsyncIterable<never> {}
  async importMarkdown(): Promise<MemoryRevision> {
    return { id: "noop", path: "", revision: 1, content: "" };
  }
}

/**
 * A non-scripted `AgentRuntime`: the real gating (`gatedTool` inside `continueRun`) only runs
 * when the runtime calls `request.executeTool`, which the scripted runtime never does. Each
 * test sets `script` right before calling `continueRun` to drive exactly the tool call it wants
 * to observe going through the approval gate.
 */
class ToolCallRuntime implements AgentRuntime {
  script: Array<{ name: string; args: Record<string, unknown> }> = [];
  /** What the executor actually offered the model on the last `run()` call. */
  lastToolNames: string[] = [];

  describe() {
    return {
      id: "tool-call-fake",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        streaming: true,
        compaction: false,
        tools: true,
        scripted: false,
      },
    };
  }

  async abort(): Promise<void> {}

  async *run(request: AgentRunRequest, _context: AdapterContext): AsyncIterable<AgentRuntimeEvent> {
    this.lastToolNames = (request.tools ?? []).map((tool) => tool.name);
    try {
      let result: unknown;
      for (let i = 0; i < this.script.length; i += 1) {
        const call = this.script[i]!;
        result = await request.executeTool!(
          call.name,
          call.args,
          `${request.runId}:${call.name}#${i + 1}`,
        );
      }
      yield { type: "done", text: JSON.stringify(result ?? "done.") };
    } catch (error) {
      // The executor already published the ask card / peer wait and parked the run; a real
      // runtime (pi-runtime) turns this into a "waiting" tool result instead of propagating it.
      if (error instanceof ApprovalPause) return;
      throw error;
    }
  }
}

/**
 * Task 5's security requirement: an unsupervised (webhook) run's protected tools must pause
 * for a card even with auto-approve on, and that must survive an `ask_bot`/`message_teammate`/
 * `spawn_bot` hop to a teammate or child with its own auto-approve. This drives the real
 * executor and database because the gate itself, and its propagation through `createPeerWake`
 * / `spawnBot` via `Run.webhookId`, only compose correctly end to end.
 */
describeUnattended("unattended (webhook) approval policy in the real executor", () => {
  let db: ReturnType<typeof createDb>;
  let executor: ReturnType<typeof createRunExecutor>;
  let runtime: ToolCallRuntime;
  let wakeup: InMemoryWakeupDriver;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const workspaceId = `ws-unattended-${stamp}`;
  const userId = `user-unattended-${stamp}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-unattended-"));
  let webhooks = 0;

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    await db.prisma.organization.create({
      data: {
        id: workspaceId,
        name: "Unattended workspace",
        slug: `unattended-${stamp}`,
        createdAt: new Date(),
      },
    });
    runtime = new ToolCallRuntime();
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
      // Non-scripted fake runtime: the executor now requires a key after ensureComputer.
      deploymentModelKey: "test-model-key",
    });
  });

  afterAll(async () => {
    await wakeup.stop();
    await db.prisma.organization.delete({ where: { id: workspaceId } }).catch(() => undefined);
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function newBotWithComputer(name: string, options?: { autoApprove?: boolean }) {
    const bot = await db.prisma.bot.create({
      data: {
        workspaceId,
        userId,
        name,
        color: "#123456",
        autoApprove: options?.autoApprove ?? true,
      },
    });
    const thread = await db.prisma.thread.create({
      data: { workspaceId, userId, botId: bot.id },
    });
    // One computer per workspace (the real "one container, one display per bot" model);
    // every bot in this suite shares it through its own `DesktopSession` and `display`.
    const computer = await db.prisma.computer.upsert({
      where: { workspaceId },
      create: { workspaceId, userId, kind: "fake", state: "stopped" },
      update: {},
    });
    // A `spawn_bot` hop creates its child through the real `createBot` repo helper, which
    // picks the next display straight from the DB — so this cannot just count its own
    // calls (that local count would drift out of sync with a spawned child's session).
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

  /** `Run.webhookId` is a real foreign key: propagating a webhook origin needs an actual row. */
  async function newWebhook(botId: string) {
    webhooks += 1;
    const webhook = await db.prisma.webhook.create({
      data: {
        endpointId: `wh_unattended_${stamp}_${webhooks}`,
        workspaceId,
        userId,
        botId,
        name: "Origin webhook",
        prompt: "",
        secretHash: "fake-hash",
      },
    });
    return webhook.id;
  }

  async function newRun(input: {
    botId: string;
    threadId: string;
    trigger: string;
    webhookId?: string | null;
  }) {
    const task = await db.prisma.task.create({
      data: {
        workspaceId,
        botId: input.botId,
        threadId: input.threadId,
        userId,
        prompt: "handle the delivery",
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
        trigger: input.trigger,
        webhookId: input.webhookId ?? undefined,
      },
    });
  }

  it("pauses an ordinary tool for a webhook run even though the bot auto-approves, and offers no 'always' action", async () => {
    const { bot, thread } = await newBotWithComputer("Webhook target");
    const webhookId = await newWebhook(bot.id);
    const run = await newRun({
      botId: bot.id,
      threadId: thread.id,
      trigger: "webhook",
      webhookId,
    });
    runtime.script = [
      {
        name: "write_file",
        args: { path: "notes/build.txt", content: "from a webhook" },
      },
    ];

    await executor.continueRun(run.id, "worker-unattended");

    const after = await db.prisma.run.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(after.status).toBe("waiting_input");
    const checkpoint = parseRunCheckpoint(after.checkpoint);
    expect(checkpoint.pendingApproval).toMatchObject({ tool: "write_file" });

    const ask = await db.prisma.message.findFirstOrThrow({
      where: { threadId: thread.id, role: "bot" },
      orderBy: { seq: "desc" },
    });
    expect(ask.blocks).toMatchObject([{ kind: "ask", tool: "write_file" }]);
    const askBlock = (ask.blocks as Array<{ actions?: Array<{ id: string }> }>)[0];
    // Only allow/deny for an unattended run: "always" would grant standing consent nobody
    // watching this card could meaningfully give.
    expect(askBlock?.actions?.map((action) => action.id)).toEqual(["allow", "deny"]);
  });

  it("does not expose takeover or subagent native effects to an unattended model", async () => {
    const { bot, thread } = await newBotWithComputer("Webhook native tools");
    const webhookId = await newWebhook(bot.id);
    const run = await newRun({
      botId: bot.id,
      threadId: thread.id,
      trigger: "webhook",
      webhookId,
    });
    runtime.script = [];

    await executor.continueRun(run.id, "worker-unattended");

    expect(runtime.lastToolNames).not.toContain("request_takeover");
    expect(runtime.lastToolNames).not.toContain("run_subagent");
  });

  it("still auto-approves the same ordinary tool for a normal (non-webhook) run", async () => {
    const { bot, thread } = await newBotWithComputer("Ordinary target");
    const run = await newRun({
      botId: bot.id,
      threadId: thread.id,
      trigger: "user",
    });
    runtime.script = [
      {
        name: "write_file",
        args: { path: "notes/build.txt", content: "from a person" },
      },
    ];

    await executor.continueRun(run.id, "worker-unattended");

    const after = await db.prisma.run.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(after.status).toBe("completed");
    expect(after.checkpoint).toBeNull();
  });

  it("keeps the 'always' action for an ordinary (attended) run's approval card", async () => {
    const { bot, thread } = await newBotWithComputer("Attended asker", {
      autoApprove: false,
    });
    const run = await newRun({
      botId: bot.id,
      threadId: thread.id,
      trigger: "user",
    });
    runtime.script = [
      {
        name: "write_file",
        args: { path: "notes/attended.txt", content: "from a person" },
      },
    ];

    await executor.continueRun(run.id, "worker-unattended");

    const ask = await db.prisma.message.findFirstOrThrow({
      where: { threadId: thread.id, role: "bot" },
      orderBy: { seq: "desc" },
    });
    const askBlock = (ask.blocks as Array<{ actions?: Array<{ id: string }> }>)[0];
    expect(askBlock?.actions?.map((action) => action.id)).toEqual(["allow", "deny", "always"]);
  });

  it("requires approval before a webhook can fan out through ask_bot", async () => {
    const { bot: asker, thread: askerThread } = await newBotWithComputer("Webhook asker");
    const { bot: teammate, thread: teammateThread } = await newBotWithComputer("Webhook peer");
    const webhookId = await newWebhook(asker.id);
    const run = await newRun({
      botId: asker.id,
      threadId: askerThread.id,
      trigger: "webhook",
      webhookId,
    });
    runtime.script = [
      {
        name: "ask_bot",
        args: { name: teammate.name, message: "pode revisar isso?" },
      },
    ];

    await executor.continueRun(run.id, "worker-unattended");

    const askerAfter = await db.prisma.run.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(askerAfter.status).toBe("waiting_input");
    expect(parseRunCheckpoint(askerAfter.checkpoint).pendingApproval).toMatchObject({
      tool: "ask_bot",
    });
    expect(await db.prisma.run.count({ where: { botId: teammate.id } })).toBe(0);
    expect(
      await db.prisma.message.count({
        where: { threadId: teammateThread.id },
      }),
    ).toBe(0);
  });

  it("requires approval before a webhook can fan out through message_teammate", async () => {
    const { bot: sender, thread: senderThread } = await newBotWithComputer("Webhook sender");
    const { bot: teammate } = await newBotWithComputer("Message peer");
    const webhookId = await newWebhook(sender.id);
    const run = await newRun({
      botId: sender.id,
      threadId: senderThread.id,
      trigger: "webhook",
      webhookId,
    });
    runtime.script = [
      {
        name: "message_teammate",
        args: { name: teammate.name, message: "recado assíncrono" },
      },
    ];

    await executor.continueRun(run.id, "worker-unattended");

    const senderAfter = await db.prisma.run.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(senderAfter.status).toBe("waiting_input");
    expect(parseRunCheckpoint(senderAfter.checkpoint).pendingApproval).toMatchObject({
      tool: "message_teammate",
    });
    expect(await db.prisma.run.count({ where: { botId: teammate.id } })).toBe(0);
  });

  it("propagates the webhook origin through a spawn_bot approval, into the spawned child's first run", async () => {
    const { bot: spawner, thread: spawnerThread } = await newBotWithComputer("Webhook spawner");
    const webhookId = await newWebhook(spawner.id);
    const run = await newRun({
      botId: spawner.id,
      threadId: spawnerThread.id,
      trigger: "webhook",
      webhookId,
    });
    runtime.script = [
      {
        name: "spawn_bot",
        args: { name: "Spawned Helper", prompt: "toque o trabalho" },
      },
    ];

    await executor.continueRun(run.id, "worker-unattended");

    // spawn_bot always asks for a card — that is unaffected by unattended — and here the
    // card also carries no "always" action, same as any other unattended pause.
    const afterAsk = await db.prisma.run.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(afterAsk.status).toBe("waiting_input");
    const checkpoint = parseRunCheckpoint(afterAsk.checkpoint);
    expect(checkpoint.pendingApproval).toMatchObject({ tool: "spawn_bot" });
    const ask = await db.prisma.message.findFirstOrThrow({
      where: { threadId: spawnerThread.id, role: "bot" },
      orderBy: { seq: "desc" },
    });
    const askBlock = (ask.blocks as Array<{ actions?: Array<{ id: string }> }>)[0];
    expect(askBlock?.actions?.map((action) => action.id)).toEqual(["allow", "deny"]);

    // Simulate the explicit approval the card offers — allow, once.
    await db.prisma.run.update({
      where: { id: run.id },
      data: {
        checkpoint: approvalCheckpoint(checkpoint.pendingApproval!, "allow"),
      },
    });
    runtime.script = [];
    await executor.continueRun(run.id, "worker-unattended-resume");

    const spawnedChild = await db.prisma.bot.findFirstOrThrow({
      where: { parentBotId: spawner.id },
    });
    const childRun = await db.prisma.run.findFirstOrThrow({
      where: { botId: spawnedChild.id },
    });
    // Trigger stays the ordinary "spawn"; only webhookId carries the causal origin forward.
    expect(childRun.trigger).toBe("spawn");
    expect(childRun.webhookId).toBe(webhookId);
  });

  it("coerces a raw 'always' checkpoint decision to a one-shot allow on resume for a webhook run, without granting bot.alwaysAllow", async () => {
    const { bot, thread } = await newBotWithComputer("Webhook resumer");
    const webhookId = await newWebhook(bot.id);
    const run = await newRun({
      botId: bot.id,
      threadId: thread.id,
      trigger: "webhook",
      webhookId,
    });
    runtime.script = [
      {
        name: "write_file",
        args: { path: "notes/always.txt", content: "from a webhook" },
      },
    ];

    await executor.continueRun(run.id, "worker-unattended");
    const paused = await db.prisma.run.findUniqueOrThrow({
      where: { id: run.id },
    });
    const checkpoint = parseRunCheckpoint(paused.checkpoint);
    expect(checkpoint.pendingApproval).toMatchObject({ tool: "write_file" });

    // The card itself never offered "always" (see the earlier pause test), but this proves
    // the resume path does not simply trust a raw "always" reaching it some other way (a
    // stale checkpoint, a direct DB write) either: it still coerces down to a one-shot allow.
    await db.prisma.run.update({
      where: { id: run.id },
      data: {
        checkpoint: approvalCheckpoint(checkpoint.pendingApproval!, "always"),
      },
    });
    runtime.script = [];
    await executor.continueRun(run.id, "worker-unattended-resume");

    const afterResume = await db.prisma.bot.findUniqueOrThrow({
      where: { id: bot.id },
    });
    expect(afterResume.alwaysAllow).toEqual([]);
    const finalRun = await db.prisma.run.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(finalRun.status).toBe("completed");
    expect(finalRun.checkpoint).toBeNull();

    // Resuming appends a fresh "done." reply after the answered card, so it is no longer
    // the most recent bot message — find it by the request id the pause itself minted.
    const messages = await db.prisma.message.findMany({
      where: { threadId: thread.id, role: "bot" },
      orderBy: { seq: "desc" },
    });
    const askMessage = messages.find((m) =>
      (m.blocks as Array<{ kind?: string; requestId?: string }>).some(
        (block) =>
          block.kind === "ask" && block.requestId === checkpoint.pendingApproval!.requestId,
      ),
    );
    // The ask card that was answered records the decision that actually applied, "allow" —
    // not the raw "always" the checkpoint carried.
    const askBlock = (askMessage?.blocks as Array<{ answered?: string }> | undefined)?.[0];
    expect(askBlock?.answered).toBe("allow");
  });

  it("still grants bot.alwaysAllow on resume for an ordinary (attended) run's raw 'always'", async () => {
    const { bot, thread } = await newBotWithComputer("Attended resumer", {
      autoApprove: false,
    });
    const run = await newRun({
      botId: bot.id,
      threadId: thread.id,
      trigger: "user",
    });
    runtime.script = [
      {
        name: "write_file",
        args: { path: "notes/attended-always.txt", content: "from a person" },
      },
    ];

    await executor.continueRun(run.id, "worker-unattended");
    const paused = await db.prisma.run.findUniqueOrThrow({
      where: { id: run.id },
    });
    const checkpoint = parseRunCheckpoint(paused.checkpoint);

    await db.prisma.run.update({
      where: { id: run.id },
      data: {
        checkpoint: approvalCheckpoint(checkpoint.pendingApproval!, "always"),
      },
    });
    runtime.script = [];
    await executor.continueRun(run.id, "worker-unattended-resume");

    const afterResume = await db.prisma.bot.findUniqueOrThrow({
      where: { id: bot.id },
    });
    expect(afterResume.alwaysAllow).toContain("write_file");
  });
});
