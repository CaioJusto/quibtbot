import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DesktopSandboxProvider,
  FakeSandboxProvider,
  ManagedSandboxEmulator,
} from "@quibt/adapters";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";
process.env.BOOTSTRAP_SECRET ??= "journey-bootstrap-secret-32chars-min";

const JOURNEY_BOOTSTRAP_SECRET = process.env.BOOTSTRAP_SECRET;

const hasDb = Boolean(process.env.DATABASE_URL);
const describeJourneys = hasDb ? describe : describe.skip;

describeJourneys("required product journeys", () => {
  let app: App;
  let stop: () => Promise<void>;
  let prisma: Awaited<
    ReturnType<typeof import("../../../apps/api/src/app.ts").createApp>
  >["prisma"];
  let connector: Awaited<
    ReturnType<typeof import("../../../apps/api/src/app.ts").createApp>
  >["connector"];
  let executor: Awaited<
    ReturnType<typeof import("../../../apps/api/src/app.ts").createApp>
  >["executor"];
  let wakeup: Awaited<
    ReturnType<typeof import("../../../apps/api/src/app.ts").createApp>
  >["wakeup"];
  const stamp = Date.now();
  const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-journey-"));

  beforeEach(async () => {
    // Every journey signs up fresh users against one in-process app; without a
    // reset the per-IP auth limiter treats the suite as one abusive client.
    const { resetRateLimits } = await import("../../../apps/api/src/rate-limit.ts");
    resetRateLimits();
  });

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      bootstrapSecret: JOURNEY_BOOTSTRAP_SECRET,
    });
    app = handles.app;
    stop = handles.stop;
    prisma = handles.prisma;
    connector = handles.connector;
    executor = handles.executor;
    wakeup = handles.wakeup;

    const settings = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
    const claim = await prisma.deploymentClaim.findUnique({ where: { id: "default" } });
    if (!settings?.ownerUserId) {
      await bootstrapOwnerSignup(app, `journey-seed-${stamp}@quibt.test`, "Journey Seed");
    } else if (!claim?.claimedAt) {
      await prisma.deploymentClaim.update({
        where: { id: "default" },
        data: { claimedAt: new Date() },
      });
    }
    await prisma.deploymentSettings.update({
      where: { id: "default" },
      data: { signupsEnabled: true },
    });
  });

  afterAll(async () => {
    await stop();
  });

  it("1+2: users are isolated while bots share one workspace machine and filesystem", async () => {
    const ada = await signup(app, `ada-j-${stamp}@quibt.test`, "Ada Journey");
    const bob = await signup(app, `bob-j-${stamp}@quibt.test`, "Bob Journey");

    const adaMe = await rpc<Me>(app, ada, "me");
    const bobMe = await rpc<Me>(app, bob, "me");
    expect(adaMe.workspaceId).not.toBe(bobMe.workspaceId);

    const chief = await rpc<Bot>(app, ada, "bots/create", {
      name: "Chief",
      title: "Chief of staff",
      description: "Keeps work moving",
      instructions: "",
      notifyOnFinish: true,
    });
    const coder = await rpc<Bot>(app, ada, "bots/create", {
      name: "Coder",
      title: "Engineer",
      description: "Writes code",
      instructions: "",
      notifyOnFinish: true,
    });
    const bobBot = await rpc<Bot>(app, bob, "bots/create", {
      name: "Chief",
      title: "Chief of staff",
      description: "Bob's bot",
      instructions: "",
      notifyOnFinish: true,
    });

    const bobList = await rpc<Bot[]>(app, bob, "bots/list");
    expect(bobList.map((b) => b.id)).not.toContain(chief.id);
    const forbidden = await raw(app, bob, "bots/get", { botId: chief.id });
    expect(forbidden.status).toBeGreaterThanOrEqual(400);

    await sendAndWait(
      app,
      ada,
      chief.id,
      "write a file in your home called notes/result.txt that says isolation-ok",
    );
    await sendAndWait(app, ada, coder.id, "remember that coder prefers rust");

    const chiefFile = await rpc<{ path: string; content: string }>(app, ada, "computer/readFile", {
      botId: chief.id,
      path: "notes/result.txt",
    });
    expect(chiefFile.content).toContain("isolation-ok");
    const coderView = await rpc<{ path: string; content: string }>(app, ada, "computer/readFile", {
      botId: coder.id,
      path: "notes/result.txt",
    });
    expect(coderView.content).toContain("isolation-ok");
    const desktops = await prisma.desktopSession.findMany({
      where: { botId: { in: [chief.id, coder.id] } },
      orderBy: { display: "asc" },
    });
    expect(new Set(desktops.map((desktop) => desktop.computerId)).size).toBe(1);
    expect(new Set(desktops.map((desktop) => desktop.display)).size).toBe(2);
    const computer = await rpc<{ state: string }>(app, ada, "computer/status", { botId: chief.id });
    expect(computer.state).toBe("running");
    const coderMem = await rpc<Array<{ content: string }>>(app, ada, "memory/list", {
      botId: coder.id,
    });
    expect(coderMem.some((m) => m.content.toLowerCase().includes("rust"))).toBe(true);
    expect(bobBot.id).not.toBe(chief.id);
  });

  it("3: disconnect and reconnect from a cursor reconstructs the thread", async () => {
    const cookie = await signup(app, `cursor-j-${stamp}@quibt.test`, "Cursor");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await sendAndWait(
      app,
      cookie,
      bot.id,
      "write a file in your home called notes/result.txt that says reconnect-ok",
    );
    const snap = await rpc<Snap>(app, cookie, "threads/get", { botId: bot.id });
    expect(snap.messages.map((m) => m.seq)).toEqual(
      [...snap.messages].map((m) => m.seq).sort((a, b) => a - b),
    );
    expect(snap.messages.some((m) => JSON.stringify(m.blocks).includes("reconnect-ok"))).toBe(true);
    const again = await rpc<Snap>(app, cookie, "threads/get", { botId: bot.id, afterSeq: -1 });
    expect(again.messages.length).toBe(snap.messages.length);
  });

  it("4: takeover login then resume without exposing credentials", async () => {
    const cookie = await signup(app, `takeover-j-${stamp}@quibt.test`, "Takeover");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await rpc(app, cookie, "threads/send", {
      botId: bot.id,
      text: "install the gsc cli and sign in",
    });
    const waiting = await waitFor(
      app,
      cookie,
      bot.id,
      (snap) => snap.run?.status === "waiting_takeover",
    );
    expect(JSON.stringify(waiting.messages)).not.toMatch(/password|secret|token/i);
    await rpc(app, cookie, "computer/boot", { botId: bot.id });
    await rpc(app, cookie, "computer/takeover", { botId: bot.id });
    const done = await waitFor(app, cookie, bot.id, (snap) => {
      const terminal = !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status);
      const resumed = /signed in|session/.test(JSON.stringify(snap.messages).toLowerCase());
      return terminal && resumed;
    });
    expect(JSON.stringify(done.messages).toLowerCase()).toMatch(/signed in|session/);
    expect(done.run?.status ?? "completed").not.toBe("waiting_takeover");
  });

  it("5: a routine wakes the bot, posts into the existing thread, and schedules its next run", async () => {
    const cookie = await signup(app, `routine-j-${stamp}@quibt.test`, "Routine");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const routine = await rpc<{ id: string }>(app, cookie, "routines/create", {
      botId: bot.id,
      name: "Monday briefing",
      prompt: "write a file in your home called notes/result.txt that says routine-ok",
      cron: "0 9 * * 1",
      timezone: "UTC",
      notify: true,
      active: true,
    });
    const scheduled: Array<Parameters<typeof wakeup.enqueue>[0]> = [];
    const originalEnqueue = wakeup.enqueue;
    wakeup.enqueue = async (job) => {
      scheduled.push(job);
    };
    try {
      await executor.wakeRoutine(routine.id, "journey");
    } finally {
      wakeup.enqueue = originalEnqueue;
    }
    const snap = await waitFor(app, cookie, bot.id, (s) =>
      s.messages.some(
        (m) =>
          JSON.stringify(m.blocks).includes("routine-ok") ||
          JSON.stringify(m.blocks).includes("writing"),
      ),
    );
    expect(snap.messages.length).toBeGreaterThan(0);
    const nextWake = scheduled.find((job) => job.name === "routine.wakeup");
    const stored = await prisma.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(nextWake?.jobKey).toBe(`routine:${routine.id}`);
    expect(nextWake?.runAt?.toISOString()).toBe(stored.nextRunAt?.toISOString());
    expect(stored.lastRunAt).not.toBeNull();
  });

  it("5b: billing blocks scheduled routines and automatic computer boot after limits expire", async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const billed = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir: mkdtempSync(path.join(tmpdir(), "quibt-billing-journey-")),
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      billingEnabled: true,
      stripeSecretKey: "sk_test_journey",
      stripeWebhookSecret: "whsec_journey",
      stripePriceStarter: "price_starter",
      stripePricePro: "price_pro",
    });
    try {
      const raceCookie = await signup(
        billed.app,
        `bot-limit-race-j-${stamp}@quibt.test`,
        "Bot Limit Race",
      );
      const raceMe = await rpc<Me>(billed.app, raceCookie, "me");
      const createInput = {
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      };
      const raced = await Promise.all([
        raw(billed.app, raceCookie, "bots/create", { ...createInput, name: "Race A" }),
        raw(billed.app, raceCookie, "bots/create", { ...createInput, name: "Race B" }),
      ]);
      expect(raced.map((response) => response.status).sort()).toEqual([200, 403]);
      expect(await billed.prisma.bot.count({ where: { workspaceId: raceMe.workspaceId } })).toBe(1);

      const expiredCookie = await signup(
        billed.app,
        `expired-billing-j-${stamp}@quibt.test`,
        "Expired Billing",
      );
      const expiredBot = await rpc<Bot>(billed.app, expiredCookie, "bots/create", {
        name: "Expired",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      const expiredRoutine = await rpc<{ id: string }>(
        billed.app,
        expiredCookie,
        "routines/create",
        {
          botId: expiredBot.id,
          name: "Must not run",
          prompt: "do not execute",
          cron: "0 9 * * *",
          timezone: "UTC",
          notify: false,
          active: true,
        },
      );
      await billed.prisma.billingAccount.update({
        where: { workspaceId: expiredBot.workspaceId },
        data: { trialEndsAt: new Date(Date.now() - 60_000) },
      });
      expect(
        await raw(billed.app, expiredCookie, "bots/create", {
          name: "Must be blocked",
          title: "",
          description: "",
          instructions: "",
          notifyOnFinish: false,
        }),
      ).toMatchObject({ status: 403 });
      expect(
        await raw(billed.app, expiredCookie, "threads/send", {
          botId: expiredBot.id,
          text: "must not queue",
        }),
      ).toMatchObject({ status: 403 });
      expect(
        await raw(billed.app, expiredCookie, "routines/testRun", {
          routineId: expiredRoutine.id,
        }),
      ).toMatchObject({ status: 403 });
      const runsBefore = await billed.prisma.run.count({
        where: { workspaceId: expiredBot.workspaceId },
      });
      await billed.executor.wakeRoutine(expiredRoutine.id, "billing-journey");
      expect(
        await billed.prisma.run.count({ where: { workspaceId: expiredBot.workspaceId } }),
      ).toBe(runsBefore);

      const limitedCookie = await signup(
        billed.app,
        `computer-limit-j-${stamp}@quibt.test`,
        "Computer Limit",
      );
      const limitedBot = await rpc<Bot>(billed.app, limitedCookie, "bots/create", {
        name: "Limited",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      const queued: Array<Parameters<typeof billed.wakeup.enqueue>[0]> = [];
      const originalEnqueue = billed.wakeup.enqueue;
      billed.wakeup.enqueue = async (job) => {
        queued.push(job);
      };
      const sent = await rpc<{ runId: string }>(billed.app, limitedCookie, "threads/send", {
        botId: limitedBot.id,
        text: "this run must hit the computer quota",
      });
      billed.wakeup.enqueue = originalEnqueue;
      const endedAt = new Date();
      const startedAt = new Date(endedAt.getTime() - 21 * 60 * 60 * 1000);
      await billed.prisma.billingAccount.update({
        where: { workspaceId: limitedBot.workspaceId },
        data: { createdAt: new Date(endedAt.getTime() - 22 * 60 * 60 * 1000) },
      });
      await billed.prisma.computerUsage.create({
        data: {
          workspaceId: limitedBot.workspaceId,
          botId: limitedBot.id,
          startedAt,
          endedAt,
          ms: endedAt.getTime() - startedAt.getTime(),
        },
      });
      await billed.executor.continueRun(sent.runId, "billing-journey");
      const failed = await billed.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } });
      expect(queued.some((job) => job.name === "run.continue")).toBe(true);
      expect(failed.status).toBe("failed");
      expect(failed.error).toMatch(/Limite mensal de computador/i);
    } finally {
      await billed.stop();
    }
  });

  it("6: fake, managed-sandbox emulator, and desktop executor run the same graphical task", async () => {
    const ctx = {
      operationId: "1",
      traceId: "1",
      workspaceId: "w",
      userId: "u",
      signal: new AbortController().signal,
    };
    const fake = new FakeSandboxProvider();
    const managed = new ManagedSandboxEmulator();
    const desktop = new DesktopSandboxProvider();
    const a = await fake.provision({ botId: "ja", homePath: "/tmp/ja" }, ctx);
    const b = await managed.provision({ botId: "jb", homePath: "/tmp/jb" }, ctx);
    const c = await desktop.provision({ botId: "jc", homePath: "/tmp/jc" }, ctx);
    let out = "";
    for await (const event of fake.execute(a, { argv: ["echo", "same-task"] }, ctx)) {
      if (event.type === "stdout") out += event.data;
    }
    for await (const event of managed.execute(b, { argv: ["echo", "same-task"] }, ctx)) {
      if (event.type === "stdout") out += event.data;
    }
    for await (const event of desktop.execute(c, { argv: ["echo", "same-task"] }, ctx)) {
      if (event.type === "stdout") out += event.data;
    }
    expect(out.match(/same-task/g)?.length).toBe(3);
    await desktop.destroy(c, ctx);
  });

  it("7: destination write is independently inspectable and credentials stay out of the thread", async () => {
    const cookie = await signup(app, `dest-j-${stamp}@quibt.test`, "Dest");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const before = connector.records.length;
    const secret = "sk-or-v1-should-never-leak-into-thread";
    await rpc(app, cookie, "models/connect", {
      provider: "openrouter",
      apiKey: secret,
      label: "test",
      modelId: "scripted",
    });
    await sendAndWait(app, cookie, bot.id, "write this to the destination crm as a note");
    expect(connector.records.length).toBeGreaterThan(before);
    const snap = await rpc<Snap>(app, cookie, "threads/get", { botId: bot.id });
    expect(JSON.stringify(snap)).not.toContain(secret);
    const inspect = await fetch(`http://127.0.0.1:${connector.port}/records`);
    const records = (await inspect.json()) as unknown[];
    expect(records.length).toBeGreaterThan(0);
  });

  it("8: retrying a completed effect does not duplicate the destination write", async () => {
    const cookie = await signup(app, `crash-j-${stamp}@quibt.test`, "Crash");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const before = connector.records.length;
    const sent = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "write this to the destination crm as a note",
    });
    await waitFor(
      app,
      cookie,
      bot.id,
      (s) => !s.run || ["completed", "failed", "cancelled"].includes(s.run.status),
    );
    const afterFirst = connector.records.length;
    expect(afterFirst).toBeGreaterThan(before);
    await prisma.run.update({
      where: { id: sent.runId },
      data: { status: "running", completedAt: null },
    });
    await executor.continueRun(sent.runId, "retry");
    expect(connector.records.length).toBe(afterFirst);
  });

  it("9: export includes memory and files but not secrets or browser sessions", async () => {
    const cookie = await signup(app, `export-j-${stamp}@quibt.test`, "Export");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "Be useful",
      notifyOnFinish: true,
    });
    const secret = "sk-or-v1-export-must-redact-this-key";
    await rpc(app, cookie, "models/connect", {
      provider: "openrouter",
      apiKey: secret,
      label: "hidden",
      modelId: "scripted",
    });
    await sendAndWait(
      app,
      cookie,
      bot.id,
      "write a file in your home called notes/result.txt that says export-ok",
    );
    const manifest = await rpc<Record<string, unknown>>(app, cookie, "export/bot", {
      botId: bot.id,
    });
    const rawJson = JSON.stringify(manifest);
    expect(rawJson).toContain("export-ok");
    expect(rawJson).toContain("Be useful");
    expect(rawJson).not.toContain(secret);
    expect(rawJson).not.toMatch(/browserProfile|ciphertext|sessionCookie/i);
  });

  it("10: deleting a bot keeps the shared workspace home and remains isolated", async () => {
    const ada = await signup(app, `delete-j-${stamp}@quibt.test`, "Delete Ada");
    const bob = await signup(app, `delete-bob-j-${stamp}@quibt.test`, "Delete Bob");
    const adaMe = await rpc<Me>(app, ada, "me");
    const keep = await rpc<Bot>(app, ada, "bots/create", {
      name: "Keep",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const gone = await rpc<Bot>(app, ada, "bots/create", {
      name: "Gone",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await sendAndWait(
      app,
      ada,
      gone.id,
      "write a file in your home called notes/result.txt that says delete-ok",
    );
    const home = path.join(dataDir, "workspaces", adaMe.workspaceId, "home");
    expect(existsSync(home)).toBe(true);

    const stolen = await raw(app, bob, "bots/remove", { botId: gone.id });
    expect(stolen.status).toBeGreaterThanOrEqual(400);
    expect((await rpc<Bot[]>(app, ada, "bots/list")).map((bot) => bot.id)).toContain(gone.id);

    await rpc(app, ada, "bots/remove", { botId: gone.id });
    const list = await rpc<Bot[]>(app, ada, "bots/list");
    expect(list.map((bot) => bot.id)).toEqual([keep.id]);
    expect((await raw(app, ada, "bots/get", { botId: gone.id })).status).toBeGreaterThanOrEqual(
      400,
    );
    expect(existsSync(home)).toBe(true);
  });

  it("11: bots collaborate through peer wakes, mentions, and isolated group threads", async () => {
    const ada = await signup(app, `collab-j-${stamp}@quibt.test`, "Collab Ada");
    const bob = await signup(app, `collab-bob-j-${stamp}@quibt.test`, "Collab Bob");
    const chief = await rpc<Bot>(app, ada, "bots/create", {
      name: "Chief",
      title: "Coordinator",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const writer = await rpc<Bot>(app, ada, "bots/create", {
      name: "Writer",
      title: "Writer",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const outsider = await rpc<Bot>(app, bob, "bots/create", {
      name: "Outsider",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });

    const teammates = await rpc<Bot[]>(app, ada, "peers/list", { botId: chief.id });
    expect(teammates.map((bot) => bot.id)).toEqual([writer.id]);
    await rpc(app, ada, "peers/send", {
      fromBotId: chief.id,
      toBotId: writer.id,
      text: "Draft the launch note",
    });
    const peerThread = await waitFor(app, ada, writer.id, (snap) =>
      snap.messages.some((message) => message.fromBotId === chief.id),
    );
    expect(
      peerThread.messages.some(
        (message) =>
          message.fromBotId === chief.id &&
          message.role === "system" &&
          JSON.stringify(message.blocks).includes("[peer]"),
      ),
    ).toBe(true);

    // Wait for the first peer turn to finish before starting another turn on
    // the same bot. Otherwise both replies can race to become the active leaf
    // of the conversation and make the second peer cue look like a branch.
    await waitFor(app, ada, writer.id, (snap) => !snap.run);

    await sendAndWait(app, ada, chief.id, "Please ask @Writer to check the headline");
    const mentioned = await waitFor(app, ada, writer.id, (snap) =>
      snap.messages.some(
        (message) =>
          message.fromBotId === chief.id &&
          JSON.stringify(message.blocks).includes("check the headline"),
      ),
    );
    expect(mentioned.messages.some((message) => message.fromBotId === chief.id)).toBe(true);

    let group = await rpc<BotGroup>(app, ada, "botGroups/create", {
      name: "Launch room",
      botIds: [chief.id],
    });
    group = await rpc<BotGroup>(app, ada, "botGroups/addMember", {
      groupId: group.id,
      botId: writer.id,
    });
    expect(group.members.map((member) => member.id).sort()).toEqual([chief.id, writer.id].sort());
    group = await rpc<BotGroup>(app, ada, "botGroups/update", {
      groupId: group.id,
      name: "Launch council",
      instructions: "Prefer short, independent answers.",
    });
    expect(group.name).toBe("Launch council");
    expect(group.instructions).toBe("Prefer short, independent answers.");

    const targeted = await rpc<{ runIds: string[] }>(app, ada, "botGroups/send", {
      groupId: group.id,
      text: "@Chief review only this targeted line",
      mentionBotIds: [chief.id],
    });
    expect(targeted.runIds).toHaveLength(1);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: targeted.runIds[0]! } })).botId).toBe(
      chief.id,
    );
    await waitForGroup(app, ada, group.id, (snapshot) =>
      snapshot.messages.some(
        (message) =>
          message.authorBotId === chief.id &&
          JSON.stringify(message.blocks).includes("targeted line"),
      ),
    );

    const sent = await rpc<{ runIds: string[] }>(app, ada, "botGroups/send", {
      groupId: group.id,
      text: "Each of you propose a launch line",
    });
    expect(sent.runIds).toHaveLength(2);
    const groupThread = await waitForGroup(app, ada, group.id, (snapshot) => {
      const authors = new Set(
        snapshot.messages.map((message) => message.authorBotId).filter(Boolean),
      );
      return snapshot.runs.length === 0 && authors.has(chief.id) && authors.has(writer.id);
    });
    expect(
      new Set(groupThread.messages.map((message) => message.authorBotId).filter(Boolean)),
    ).toEqual(new Set([chief.id, writer.id]));

    const groupRoutine = await rpc<{ id: string }>(app, ada, "routines/create", {
      groupId: group.id,
      name: "Council check-in",
      prompt: "Each member post a scheduled check-in",
      cron: "0 9 * * 1",
      timezone: "UTC",
      notify: true,
      active: true,
    });
    const routineWakes: Array<Parameters<typeof wakeup.enqueue>[0]> = [];
    const originalEnqueue = wakeup.enqueue;
    wakeup.enqueue = async (job) => {
      routineWakes.push(job);
    };
    try {
      await executor.wakeRoutine(groupRoutine.id, "journey-group");
    } finally {
      wakeup.enqueue = originalEnqueue;
    }
    expect(routineWakes.some((job) => job.jobKey === `routine:${groupRoutine.id}`)).toBe(true);
    const routineRuns = await prisma.run.findMany({
      where: { threadId: group.threadId, trigger: "routine" },
    });
    expect(new Set(routineRuns.map((run) => run.botId))).toEqual(new Set([chief.id, writer.id]));

    expect(
      (await raw(app, bob, "botGroups/get", { groupId: group.id })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await raw(app, bob, "peers/send", {
          fromBotId: outsider.id,
          toBotId: chief.id,
          text: "cross workspace",
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);

    await rpc(app, ada, "botGroups/removeMember", { groupId: group.id, botId: writer.id });
    await rpc(app, ada, "botGroups/remove", { groupId: group.id });
    expect(
      (await rpc<BotGroup[]>(app, ada, "botGroups/list")).map((item) => item.id),
    ).not.toContain(group.id);
  });

  it("13: a bot can spawn a regular bot and must confirm the name to delete it", async () => {
    const cookie = await signup(app, `spawn-j-${stamp}@quibt.test`, "Spawn");
    const parent = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await sendAndWait(app, cookie, parent.id, "spawn a bot named Scout to research venues");
    const listed = await rpc<Bot[]>(app, cookie, "bots/list");
    const scout = listed.find((bot) => bot.name === "Scout");
    expect(scout).toBeTruthy();
    expect(listed.map((bot) => bot.name).sort()).toEqual(["Chief", "Scout"]);
    await waitFor(
      app,
      cookie,
      scout!.id,
      (s) => !s.run || ["completed", "failed", "cancelled"].includes(s.run.status),
    );
    const snap = await rpc<Snap>(app, cookie, "threads/get", { botId: parent.id });
    expect(JSON.stringify(snap.messages)).toMatch(/child_bot|Scout/);

    await sendAndWait(app, cookie, scout!.id, "spawn a bot named Nested");
    const afterNested = await rpc<Bot[]>(app, cookie, "bots/list");
    const nested = afterNested.find((bot) => bot.name === "Nested");
    expect(nested).toBeTruthy();
    expect(afterNested.map((bot) => bot.name).sort()).toEqual(["Chief", "Nested", "Scout"]);
    await waitFor(
      app,
      cookie,
      nested!.id,
      (s) => !s.run || ["completed", "failed", "cancelled"].includes(s.run.status),
    );

    await sendAndWait(app, cookie, parent.id, "delete the bot named Nested");
    expect((await rpc<Bot[]>(app, cookie, "bots/list")).some((bot) => bot.id === nested!.id)).toBe(
      true,
    );

    await sendAndWait(app, cookie, parent.id, "delete the bot named WrongName");
    expect((await rpc<Bot[]>(app, cookie, "bots/list")).some((bot) => bot.id === scout!.id)).toBe(
      true,
    );

    await sendAndWait(app, cookie, parent.id, "delete the bot named Scout");
    const afterScout = await rpc<Bot[]>(app, cookie, "bots/list");
    expect(afterScout.some((bot) => bot.id === scout!.id)).toBe(false);
    expect(afterScout.some((bot) => bot.id === nested!.id)).toBe(true);

    await rpc(app, cookie, "bots/remove", { botId: parent.id });
    expect((await rpc<Bot[]>(app, cookie, "bots/list")).map((bot) => bot.name)).toEqual(["Nested"]);
  });

  it("14: a subagent shows up in the parent thread without creating a bot", async () => {
    const cookie = await signup(app, `subagent-j-${stamp}@quibt.test`, "Subagent");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const before = (await rpc<Bot[]>(app, cookie, "bots/list")).length;
    const snap = await sendAndWait(app, cookie, bot.id, "run a subagent to summarize the notes");
    expect(JSON.stringify(snap.messages)).toMatch(/subagent|helper/);
    expect(await rpc<Bot[]>(app, cookie, "bots/list")).toHaveLength(before);
  });

  it("15: a push token follows the current account and unregister is owner-scoped", async () => {
    const ada = await signup(app, `push-ada-${stamp}@quibt.test`, "Push Ada");
    const bob = await signup(app, `push-bob-${stamp}@quibt.test`, "Push Bob");
    const adaMe = await rpc<Me>(app, ada, "me");
    const bobMe = await rpc<Me>(app, bob, "me");
    const token = "ExpoPushToken[shared-device]";

    await rpc(app, ada, "notifications/registerPush", { token });
    expect(await prisma.pushToken.findUnique({ where: { token } })).toMatchObject({
      userId: adaMe.userId,
    });

    await rpc(app, bob, "notifications/registerPush", { token });
    expect(await prisma.pushToken.findUnique({ where: { token } })).toMatchObject({
      userId: bobMe.userId,
    });

    await rpc(app, ada, "notifications/unregisterPush", { token });
    expect(await prisma.pushToken.findUnique({ where: { token } })).toMatchObject({
      userId: bobMe.userId,
    });
    await rpc(app, bob, "notifications/unregisterPush", { token });
    expect(await prisma.pushToken.findUnique({ where: { token } })).toBeNull();
  });

  it("16: a webhook delivery reaches the bot thread once, dedupes by delivery id, and stays workspace-isolated", async () => {
    const cookie = await signup(app, `webhook-j-${stamp}@quibt.test`, "Webhook");
    const bot = await rpc<Bot>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const created = await rpc<{ webhook: Webhook; credential: WebhookCredential }>(
      app,
      cookie,
      "webhooks/create",
      { botId: bot.id, name: "Build hook" },
    );
    const { endpointId } = created.webhook;
    const secret = created.credential.secret;
    // No "write"/"file"/"home"/"note" keywords: the scripted runtime takes the generic
    // fallback branch, whose assistant text embeds a prefix of the raw prompt — which is
    // exactly what proves the webhook's trust markers reached the thread, not just any
    // background work happened.
    const task = "Summarize the incoming webhook event and note any action items.";

    const first = await app.request(`/hooks/${endpointId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        "idempotency-key": "webhook-delivery-1",
      },
      body: JSON.stringify({ task }),
    });
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as {
      accepted: boolean;
      duplicate: boolean;
      runId: string | null;
    };
    expect(firstBody).toMatchObject({ accepted: true, duplicate: false });
    expect(firstBody.runId).toBeTruthy();

    const snap = await waitFor(
      app,
      cookie,
      bot.id,
      (s) => !s.run || ["completed", "failed", "cancelled"].includes(s.run.status),
    );
    const threadJson = JSON.stringify(snap.messages);
    expect(threadJson).toMatch(
      /TAREFA AUTENTICADA DO WEBHOOK|Summarize the incoming webhook event/,
    );
    expect(threadJson).not.toContain(secret);
    expect(
      await prisma.run.count({ where: { webhookId: created.webhook.id, trigger: "webhook" } }),
    ).toBe(1);

    // Retrying the exact same delivery id must return the original run, not create a second one.
    const retry = await app.request(`/hooks/${endpointId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        "idempotency-key": "webhook-delivery-1",
      },
      body: JSON.stringify({ task }),
    });
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({
      accepted: true,
      duplicate: true,
      runId: firstBody.runId,
    });
    expect(
      await prisma.run.count({ where: { webhookId: created.webhook.id, trigger: "webhook" } }),
    ).toBe(1);

    // A second, distinct delivery id is a genuinely new event: it gets its own run.
    const second = await app.request(`/hooks/${endpointId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        "idempotency-key": "webhook-delivery-2",
      },
      body: JSON.stringify({ task }),
    });
    expect(second.status).toBe(202);
    const secondBody = (await second.json()) as { duplicate: boolean; runId: string | null };
    expect(secondBody.duplicate).toBe(false);
    expect(secondBody.runId).not.toBe(firstBody.runId);
    await waitFor(
      app,
      cookie,
      bot.id,
      (s) => !s.run || ["completed", "failed", "cancelled"].includes(s.run.status),
    );
    expect(
      await prisma.run.count({ where: { webhookId: created.webhook.id, trigger: "webhook" } }),
    ).toBe(2);

    // A different workspace cannot see this webhook at all.
    const outsider = await signup(app, `webhook-outsider-j-${stamp}@quibt.test`, "Outsider");
    const forbidden = await raw(app, outsider, "webhooks/list", { botId: bot.id });
    expect(forbidden.status).toBeGreaterThanOrEqual(400);
  });

  it("12: compose backup docs and dump tooling exist", async () => {
    expect(existsSync(path.resolve("docs/self-host.md"))).toBe(true);
    expect(existsSync(path.resolve("infra/compose/docker-compose.yml"))).toBe(true);
    expect(existsSync(path.resolve("scripts/backup.sh"))).toBe(true);
    expect(existsSync(path.resolve("scripts/restore.sh"))).toBe(true);
    const docs = readFileSync(path.resolve("docs/self-host.md"), "utf8");
    expect(docs).toMatch(/pg_dump/);
    expect(docs).toMatch(/Restore/);
  });
});

describeJourneys("bootstrap pairing journey", () => {
  let app: App;
  let stop: () => Promise<void>;
  let prisma: Awaited<
    ReturnType<typeof import("../../../apps/api/src/app.ts").createApp>
  >["prisma"];
  const stamp = Date.now();
  const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-bootstrap-journey-"));

  beforeEach(async () => {
    const { resetRateLimits } = await import("../../../apps/api/src/rate-limit.ts");
    resetRateLimits();
    await prisma.bootstrapInvite.deleteMany();
    await prisma.deploymentClaim.update({
      where: { id: "default" },
      data: { claimedAt: null },
    });
    await prisma.deploymentSettings.update({
      where: { id: "default" },
      data: { ownerUserId: null, signupsEnabled: true },
    });
  });

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      bootstrapSecret: JOURNEY_BOOTSTRAP_SECRET,
    });
    app = handles.app;
    stop = handles.stop;
    prisma = handles.prisma;
  });

  afterAll(async () => {
    await stop();
  });

  it("local invite, mobile claim, owner signup, and authenticated me", async () => {
    const mint = await app.request(
      "http://localhost/api/bootstrap/invites",
      {
        method: "POST",
        headers: {
          "x-quibt-bootstrap-secret": JOURNEY_BOOTSTRAP_SECRET,
          "content-type": "application/json",
        },
      },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
    );
    expect(mint.status).toBe(200);
    const { code } = (await mint.json()) as { code: string };

    const claim = await app.request(
      "http://localhost/api/bootstrap/claim",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      },
      { incoming: { socket: { remoteAddress: "203.0.113.22" } } },
    );
    expect(claim.status).toBe(200);
    const { enrollmentToken } = (await claim.json()) as { enrollmentToken: string };

    const email = `bootstrap-owner-${stamp}@quibt.test`;
    const cookie = await signupWithEnrollment(app, email, "Bootstrap Owner", enrollmentToken);
    const me = await rpc<Me>(app, cookie, "me");
    expect(me.email).toBe(email);
    expect(me.isDeploymentOwner).toBe(true);
  });
});

type Me = {
  workspaceId: string;
  userId: string;
  email?: string;
  isDeploymentOwner?: boolean;
};
type Bot = { id: string; name: string; parentBotId?: string | null };
type BotGroup = {
  id: string;
  name: string;
  instructions: string;
  threadId: string;
  members: Array<{ id: string }>;
};
type Webhook = { id: string; endpointId: string; botId: string };
type WebhookCredential = { endpointUrl: string; secret: string; url: string };
type Snap = {
  messages: Array<{
    seq: number;
    blocks: unknown[];
    role: string;
    fromBotId?: string;
    authorBotId?: string;
  }>;
  run: { status: string } | null;
};
type GroupSnap = {
  messages: Array<{ blocks: unknown[]; authorBotId?: string }>;
  runs: Array<{ status: string }>;
};

async function signup(app: App, email: string, name: string) {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ email, password: "password12", name }),
  });
  if (res.status >= 400) {
    throw new Error(`signup failed ${res.status}: ${await res.text()}`);
  }
  return cookieHeader(res);
}

async function signupWithEnrollment(
  app: App,
  email: string,
  name: string,
  enrollmentToken: string,
) {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:5173",
      "x-quibt-enrollment": enrollmentToken,
    },
    body: JSON.stringify({ email, password: "password12", name }),
  });
  if (res.status >= 400) {
    throw new Error(`signup failed ${res.status}: ${await res.text()}`);
  }
  return cookieHeader(res);
}

async function bootstrapOwnerSignup(app: App, email: string, name: string) {
  const mint = await app.request(
    "http://localhost/api/bootstrap/invites",
    {
      method: "POST",
      headers: {
        "x-quibt-bootstrap-secret": JOURNEY_BOOTSTRAP_SECRET,
        "content-type": "application/json",
      },
    },
    { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
  );
  if (mint.status >= 400) {
    throw new Error(`bootstrap mint failed ${mint.status}: ${await mint.text()}`);
  }
  const { code } = (await mint.json()) as { code: string };
  const claim = await app.request(
    "http://localhost/api/bootstrap/claim",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    },
    { incoming: { socket: { remoteAddress: "203.0.113.1" } } },
  );
  if (claim.status >= 400) {
    throw new Error(`bootstrap claim failed ${claim.status}: ${await claim.text()}`);
  }
  const { enrollmentToken } = (await claim.json()) as { enrollmentToken: string };
  return signupWithEnrollment(app, email, name, enrollmentToken);
}

function cookieHeader(res: Response) {
  const many = res.headers.getSetCookie?.() ?? [];
  if (many.length) return many.map((c) => c.split(";")[0]).join("; ");
  const single = res.headers.get("set-cookie");
  return single ? (single.split(",")[0]?.split(";")[0] ?? "") : "";
}

async function raw(app: App, cookie: string, proc: string, body: unknown = {}) {
  return app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body }),
  });
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await raw(app, cookie, proc, body);
  const text = await res.text();
  let parsed: { json?: T; error?: { message?: string } };
  try {
    parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  } catch {
    throw new Error(`${proc} ${res.status}: ${text}`);
  }
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}

async function sendAndWait(app: App, cookie: string, botId: string, text: string) {
  await rpc(app, cookie, "threads/send", { botId, text });
  return waitFor(
    app,
    cookie,
    botId,
    (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
  );
}

async function waitFor(app: App, cookie: string, botId: string, pred: (snap: Snap) => boolean) {
  const start = Date.now();
  let last: Snap | null = null;
  while (Date.now() - start < 20_000) {
    last = await rpc<Snap>(app, cookie, "threads/get", { botId });
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for thread: ${JSON.stringify(last)}`);
}

async function waitForGroup(
  app: App,
  cookie: string,
  groupId: string,
  pred: (snapshot: GroupSnap) => boolean,
) {
  const start = Date.now();
  let last: GroupSnap | null = null;
  while (Date.now() - start < 20_000) {
    last = await rpc<GroupSnap>(app, cookie, "botGroups/thread", { groupId });
    if (pred(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for group thread: ${JSON.stringify(last)}`);
}
