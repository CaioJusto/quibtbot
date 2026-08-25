import { call } from "@orpc/server";
import type { Actor } from "@quibt/contracts";
import type { PrismaClient } from "@quibt/db";
import { describe, expect, it } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

const owner: Actor = {
  userId: "user-1",
  workspaceId: "ws-1",
  workspaceRole: "owner",
  email: "owner@example.com",
  isDeploymentOwner: true,
};

interface RunRow {
  id: string;
  botId: string;
  taskId: string;
  status: string;
  trigger: string;
  webhookId: string | null;
  checkpoint: string | null;
}

const pendingApproval = {
  requestId: "req-1",
  tool: "write_file",
  args: { path: "/tmp/x" },
  executionId: "exec-1",
  allowKey: "write_file",
  summary: "escrever /tmp/x",
};

function harness(overrides: Partial<RunRow> = {}) {
  const run: RunRow = {
    id: "run-1",
    botId: "bot-1",
    taskId: "task-1",
    status: "waiting_input",
    trigger: "webhook",
    webhookId: "wh-1",
    checkpoint: JSON.stringify({ pendingApproval }),
    ...overrides,
  };
  const bot = {
    id: "bot-1",
    workspaceId: "ws-1",
    userId: "user-1",
    thread: null,
    desktopSession: null,
    alwaysAllow: [] as string[],
  };
  const jobs: Array<{ name: string; payload: unknown }> = [];
  const prisma = {
    bot: {
      findFirst: async () => bot,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        if (
          data.alwaysAllow &&
          typeof data.alwaysAllow === "object" &&
          "push" in (data.alwaysAllow as Record<string, unknown>)
        ) {
          bot.alwaysAllow.push((data.alwaysAllow as { push: string }).push);
        }
        return bot;
      },
    },
    run: {
      findFirst: async () => run,
      update: async ({ data }: { data: Partial<RunRow> }) => {
        Object.assign(run, data);
        return run;
      },
    },
    task: {
      update: async () => ({ id: "task-1" }),
    },
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    wakeup: {
      enqueue: async (job: { name: string; payload: unknown }) => {
        jobs.push(job);
      },
    },
    env: {
      defaultProvider: "openrouter",
      defaultModel: "model",
      screenProxySecret: "secret",
      sandboxProvider: "docker",
    },
  } as unknown as RouterDeps;
  return { router: createRouter(deps), run, bot, jobs };
}

describe("threads.answer coercing a raw 'always' for an unattended run", () => {
  it("does not grant bot.alwaysAllow for a webhook-triggered run, but still allows the tool once", async () => {
    const { router, run, bot } = harness({ trigger: "webhook", webhookId: "wh-1" });
    await call(
      router.threads.answer,
      { botId: "bot-1", runId: "run-1", answer: "always" },
      { context: { actor: owner } },
    );
    expect(bot.alwaysAllow).toEqual([]);
    expect(run.status).toBe("queued");
    expect(JSON.parse(run.checkpoint as string).decision).toBe("allow");
  });

  it("does not grant bot.alwaysAllow for a peer descendant that inherited a webhookId either", async () => {
    const { router, run, bot } = harness({ trigger: "peer", webhookId: "wh-1" });
    await call(
      router.threads.answer,
      { botId: "bot-1", runId: "run-1", answer: "always" },
      { context: { actor: owner } },
    );
    expect(bot.alwaysAllow).toEqual([]);
    expect(JSON.parse(run.checkpoint as string).decision).toBe("allow");
  });

  it("still grants bot.alwaysAllow for an ordinary attended run (no webhook origin)", async () => {
    const { router, run, bot } = harness({ trigger: "user", webhookId: null });
    await call(
      router.threads.answer,
      { botId: "bot-1", runId: "run-1", answer: "always" },
      { context: { actor: owner } },
    );
    expect(bot.alwaysAllow).toEqual(["write_file"]);
    expect(JSON.parse(run.checkpoint as string).decision).toBe("always");
  });
});
