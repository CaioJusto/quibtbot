import type { ComputerStatus, ProductEvent, ThreadSnapshot } from "@quibt/contracts";
import { describe, expect, it } from "vitest";
import { applyGroupThreadEvent, applyThreadEvent } from "./apply-thread-event.js";

function snapshot(messages: ThreadSnapshot["messages"] = []): ThreadSnapshot {
  return {
    botId: "bot-1",
    threadId: "thr-1",
    cursor: -1,
    messages,
    run: null,
    computer: {
      botId: "bot-1",
      kind: "fake",
      state: "stopped",
      controlHolder: "none",
      controlLeaseExpiresAt: null,
      screenAvailable: false,
      homeRevision: null,
    },
    conversations: [],
    activeConversationId: "convo-1",
  };
}

function event(type: ProductEvent["type"], payload: Record<string, unknown> = {}): ProductEvent {
  return {
    id: "evt-1",
    workspaceId: "ws-1",
    threadId: "thr-1",
    seq: 3,
    type,
    createdAt: "2026-08-15T12:00:00.000Z",
    payload,
  };
}

describe("applyThreadEvent", () => {
  it("replaces streaming progress instead of stacking tokens", () => {
    let current: ThreadSnapshot | null = snapshot();
    const setSnapshot = (update: typeof current | ((prev: typeof current) => typeof current)) => {
      current = typeof update === "function" ? update(current) : update;
    };
    applyThreadEvent(event("thread.progress", { text: "oi" }), setSnapshot, () => undefined);
    applyThreadEvent(event("thread.progress", { text: "oi mundo" }), setSnapshot, () => undefined);
    expect(current?.messages).toHaveLength(1);
    expect(current?.messages[0]?.blocks).toEqual([{ kind: "progress", text: "oi mundo" }]);
  });

  it("records a granted takeover on the computer status", () => {
    let computer: ComputerStatus | null = {
      botId: "bot-1",
      kind: "fake",
      state: "running",
      controlHolder: "bot",
      controlLeaseExpiresAt: null,
      screenAvailable: true,
      homeRevision: null,
    };
    applyThreadEvent(
      event("computer.takeover.granted"),
      () => undefined,
      (update) => {
        computer = typeof update === "function" ? update(computer) : update;
      },
    );
    expect(computer?.controlHolder).toBe("user");
  });

  it("clears durable and transient history when another client clears the thread", () => {
    let current: ThreadSnapshot | null = snapshot([
      {
        id: "message-1",
        threadId: "thr-1",
        seq: 1,
        role: "user",
        blocks: [{ kind: "text", text: "old" }],
        createdAt: "2026-08-15T12:00:00.000Z",
      },
      {
        id: "progress:run-1",
        threadId: "thr-1",
        seq: 2,
        role: "bot",
        blocks: [{ kind: "progress", text: "…" }],
        runId: "run-1",
        createdAt: "2026-08-15T12:00:00.000Z",
      },
    ]);
    current = {
      ...current,
      run: {
        id: "run-1",
        botId: "bot-1",
        threadId: "thr-1",
        taskId: "task-1",
        status: "running",
        trigger: "user",
        modelProvider: null,
        modelId: null,
        error: null,
        startedAt: "2026-08-15T12:00:00.000Z",
        completedAt: null,
      },
    };
    const setSnapshot = (update: typeof current | ((prev: typeof current) => typeof current)) => {
      current = typeof update === "function" ? update(current) : update;
    };
    applyThreadEvent(event("thread.cleared"), setSnapshot, () => undefined);
    expect(current).toMatchObject({ cursor: 3, messages: [], run: null });
  });

  it("clears the live run and progress when the run ends", () => {
    let current: ThreadSnapshot | null = snapshot([
      {
        id: "progress:run-1",
        threadId: "thr-1",
        seq: 2,
        role: "bot",
        blocks: [{ kind: "progress", text: "…" }],
        runId: "run-1",
        createdAt: "2026-08-15T12:00:00.000Z",
      },
    ]);
    current = {
      ...current,
      run: {
        id: "run-1",
        botId: "bot-1",
        threadId: "thr-1",
        taskId: "task-1",
        status: "running",
        trigger: "user",
        modelProvider: null,
        modelId: null,
        error: null,
        startedAt: "2026-08-15T12:00:00.000Z",
        completedAt: null,
      },
    };
    const setSnapshot = (update: typeof current | ((prev: typeof current) => typeof current)) => {
      current = typeof update === "function" ? update(current) : update;
    };
    applyThreadEvent(event("run.completed"), setSnapshot, () => undefined);
    expect(current?.run).toBeNull();
    expect(current?.messages).toEqual([]);
  });

  it("applies group messages without a full snapshot reload", () => {
    let current: import("@quibt/contracts").GroupThreadSnapshot | null = {
      groupId: "grp-1",
      threadId: "thr-1",
      cursor: -1,
      messages: [],
      runs: [
        {
          id: "run-1",
          botId: "bot-1",
          threadId: "thr-1",
          taskId: "task-1",
          status: "running",
          trigger: "group",
          modelProvider: null,
          modelId: null,
          error: null,
          startedAt: "2026-08-15T12:00:00.000Z",
          completedAt: null,
        },
      ],
    };
    const setSnapshot = (update: typeof current | ((prev: typeof current) => typeof current)) => {
      current = typeof update === "function" ? update(current) : update;
    };
    applyGroupThreadEvent(
      event("thread.message.created", {
        messageId: "m1",
        role: "bot",
        blocks: [{ kind: "text", text: "oi" }],
      }),
      setSnapshot,
    );
    expect(current?.messages).toHaveLength(1);
    applyGroupThreadEvent({ ...event("run.completed"), runId: "run-1" }, setSnapshot);
    expect(current?.runs).toEqual([]);
    expect(current?.messages[0]?.blocks).toEqual([{ kind: "text", text: "oi" }]);
  });

  it("keeps two group members streaming at once", () => {
    let current: import("@quibt/contracts").GroupThreadSnapshot | null = {
      groupId: "grp-1",
      threadId: "thr-1",
      cursor: -1,
      messages: [],
      runs: [],
    };
    const setSnapshot = (update: typeof current | ((prev: typeof current) => typeof current)) => {
      current = typeof update === "function" ? update(current) : update;
    };
    applyGroupThreadEvent(
      { ...event("thread.progress", { text: "A" }), runId: "run-a" },
      setSnapshot,
    );
    applyGroupThreadEvent(
      { ...event("thread.progress", { text: "B" }), runId: "run-b" },
      setSnapshot,
    );
    expect(current?.messages.map((message) => message.id)).toEqual([
      "progress:run-a",
      "progress:run-b",
    ]);
    applyGroupThreadEvent({ ...event("run.completed"), runId: "run-a" }, setSnapshot);
    expect(current?.messages.map((message) => message.id)).toEqual(["progress:run-b"]);
  });
});
