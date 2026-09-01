import { describe, expect, it } from "vitest";
import {
  appContract,
  CreateBotGroupInput,
  CreateBotInput,
  CreateRoutineInput,
  CreateWebhookInput,
  MAX_MODEL_INPUT_CHARS,
  MemoryContentInput,
  ModelInputText,
  ProductEventType,
  RoutineSchema,
  RunSchema,
  ThreadMessageSchema,
  UpdateRoutineInput,
} from "./index.js";

describe("contracts", () => {
  it("parses bot create input", () => {
    const parsed = CreateBotInput.parse({ name: "Chief" });
    expect(parsed.title).toBe("");
    expect(parsed.notifyOnFinish).toBe(true);
  });

  it("exposes the product rpc surface", () => {
    expect(appContract.bots.create).toBeTruthy();
    expect(appContract.bots.remove).toBeTruthy();
    expect(appContract.bots.duplicate).toBeTruthy();
    expect(appContract.botMcp.list).toBeTruthy();
    expect(appContract.botMcp.add).toBeTruthy();
    expect(appContract.botMcp.remove).toBeTruthy();
    expect(appContract.conversations.create).toBeTruthy();
    expect(appContract.threads.edit).toBeTruthy();
    expect(appContract.threads.clear).toBeTruthy();
    expect(appContract.threads.subscribe).toBeTruthy();
    expect(appContract.peers.send).toBeTruthy();
    expect(appContract.botGroups.addMember).toBeTruthy();
    expect(appContract.botGroups.send).toBeTruthy();
    expect(appContract.computer.grantFolder).toBeTruthy();
    expect(appContract.notifications.registerPush).toBeTruthy();
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
    expect(ProductEventType.options).toContain("thread.message.created");
    expect(ProductEventType.options).toContain("thread.cleared");
    expect(ProductEventType.options).toContain("thread.subagent");
    expect(ProductEventType.options).toContain("bot.spawned");
  });

  it("bounds every model-facing free-text input", () => {
    const maximum = "x".repeat(MAX_MODEL_INPUT_CHARS);
    const oversized = `${maximum}x`;

    expect(ModelInputText.safeParse(maximum).success).toBe(true);
    expect(ModelInputText.safeParse(oversized).success).toBe(false);
    expect(MemoryContentInput.safeParse("").success).toBe(true);
    expect(MemoryContentInput.safeParse(oversized).success).toBe(false);
    expect(
      CreateRoutineInput.safeParse({
        botId: "bot",
        name: "Daily check",
        prompt: oversized,
        cron: "0 9 * * *",
      }).success,
    ).toBe(false);
    expect(UpdateRoutineInput.safeParse({ routineId: "routine", prompt: oversized }).success).toBe(
      false,
    );

    const rpcInputs: Array<[unknown, Record<string, unknown>]> = [
      [appContract.threads.send, { botId: "bot", text: oversized }],
      [appContract.threads.followUp, { botId: "bot", text: oversized }],
      [appContract.threads.answer, { botId: "bot", runId: "run", answer: oversized }],
      [appContract.threads.edit, { botId: "bot", messageId: "message", text: oversized }],
      [appContract.memory.update, { documentId: "memory", content: oversized }],
      [
        appContract.routines.create,
        { botId: "bot", name: "Daily check", prompt: oversized, cron: "0 9 * * *" },
      ],
      [appContract.routines.update, { routineId: "routine", prompt: oversized }],
    ];
    for (const [procedure, input] of rpcInputs) {
      expect(parseRpcInput(procedure, input).success).toBe(false);
    }
  });

  it("validates deployment.update's webhookPublicUrl: http(s) only, no credentials/query/fragment, null clears it", () => {
    const procedure = appContract.deployment.update;
    expect(parseRpcInput(procedure, {}).success).toBe(true);
    expect(parseRpcInput(procedure, { webhookPublicUrl: "https://bots.example.com" }).success).toBe(
      true,
    );
    expect(parseRpcInput(procedure, { webhookPublicUrl: "http://bots.example.com" }).success).toBe(
      true,
    );
    expect(parseRpcInput(procedure, { webhookPublicUrl: null }).success).toBe(true);
    expect(parseRpcInput(procedure, { webhookPublicUrl: "javascript:alert(1)" }).success).toBe(
      false,
    );
    expect(
      parseRpcInput(procedure, { webhookPublicUrl: "https://user:pass@bots.example.com" }).success,
    ).toBe(false);
    expect(
      parseRpcInput(procedure, { webhookPublicUrl: "https://bots.example.com/?x=1" }).success,
    ).toBe(false);
    expect(
      parseRpcInput(procedure, { webhookPublicUrl: "https://bots.example.com/#frag" }).success,
    ).toBe(false);
    expect(parseRpcInput(procedure, { webhookPublicUrl: "ftp://bots.example.com" }).success).toBe(
      false,
    );
    expect(parseRpcInput(procedure, { webhookPublicUrl: "not a url" }).success).toBe(false);
  });

  it('accepts "webhook" as a Run.trigger', () => {
    const base = {
      id: "run",
      botId: "bot",
      threadId: "thread",
      taskId: "task",
      status: "queued",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
    };
    expect(RunSchema.safeParse({ ...base, trigger: "webhook" }).success).toBe(true);
    expect(RunSchema.safeParse({ ...base, trigger: "not-a-real-trigger" }).success).toBe(false);
  });

  it("applies the create-time routine name constraints to updates", () => {
    expect(UpdateRoutineInput.safeParse({ routineId: "routine", name: "" }).success).toBe(false);
    expect(
      UpdateRoutineInput.safeParse({ routineId: "routine", name: "x".repeat(81) }).success,
    ).toBe(false);
    expect(
      UpdateRoutineInput.safeParse({ routineId: "routine", name: "Daily check" }).success,
    ).toBe(true);
  });

  it("parses collaboration metadata and group defaults", () => {
    expect(CreateBotGroupInput.parse({ name: "Launch team" }).botIds).toEqual([]);
    const message = ThreadMessageSchema.parse({
      id: "message",
      threadId: "thread",
      seq: 0,
      role: "bot",
      blocks: [{ kind: "text", text: "done" }],
      authorBotId: "writer",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(message.authorBotId).toBe("writer");
  });

  it("requires every routine to have exactly one owner", () => {
    expect(
      CreateRoutineInput.safeParse({ name: "Broken", prompt: "x", cron: "0 * * * *" }).success,
    ).toBe(false);
    expect(
      CreateRoutineInput.safeParse({
        botId: "bot",
        groupId: "group",
        name: "Broken",
        prompt: "x",
        cron: "0 * * * *",
      }).success,
    ).toBe(false);
    expect(
      CreateRoutineInput.safeParse({
        groupId: "group",
        name: "Valid",
        prompt: "x",
        cron: "0 * * * *",
      }).success,
    ).toBe(true);
    expect(
      RoutineSchema.safeParse({
        id: "routine",
        botId: null,
        groupId: null,
        name: "Broken",
        prompt: "x",
        cron: "0 * * * *",
        timezone: "UTC",
        active: true,
        notify: true,
        lastRunAt: null,
        nextRunAt: null,
        createdAt: "2026-08-13T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});

function parseRpcInput(procedure: unknown, input: unknown): { success: boolean } {
  return (
    procedure as {
      "~orpc": { inputSchema: { safeParse(value: unknown): { success: boolean } } };
    }
  )["~orpc"].inputSchema.safeParse(input);
}
