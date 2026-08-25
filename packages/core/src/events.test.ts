import { describe, expect, it } from "vitest";
import { projectMessages, threadEventNeedsSnapshotRefresh } from "./events.js";

describe("projectMessages", () => {
  it("replays durable messages and trailing live tokens from progress events", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "thread.message.created",
        payload: { messageId: "m1", role: "user", blocks: [{ kind: "text", text: "hi" }] },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "thread.progress",
        runId: "r1",
        payload: { text: "Lis", streaming: true },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "e3",
        threadId: "t1",
        seq: 2,
        type: "thread.progress",
        runId: "r1",
        payload: { text: "Lisbon", streaming: true },
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.blocks[0]).toEqual({ kind: "text", text: "hi" });
    expect(messages[1]?.blocks[0]).toEqual({ kind: "progress", text: "Lisbon" });
  });

  it("drops streaming tokens once the completed message is durable", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "thread.progress",
        runId: "r1",
        payload: { text: "Lisbon", streaming: true },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "thread.message.created",
        runId: "r1",
        payload: { messageId: "m2", role: "bot", blocks: [{ kind: "text", text: "Lisbon" }] },
        createdAt: "2026-01-01T00:00:03.000Z",
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.blocks[0]).toEqual({ kind: "text", text: "Lisbon" });
  });

  it("projects peer senders and group reply authors", () => {
    const [peer, reply] = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "thread.message.created",
        payload: {
          role: "user",
          blocks: [{ kind: "text", text: "please research this" }],
          fromBotId: "chief",
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "thread.message.created",
        payload: {
          role: "bot",
          blocks: [{ kind: "text", text: "done" }],
          authorBotId: "researcher",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    ]);
    expect(peer?.fromBotId).toBe("chief");
    expect(reply?.authorBotId).toBe("researcher");
  });

  it("keeps live subagent cards until a durable subagent message arrives", () => {
    const live = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "thread.subagent",
        runId: "r1",
        payload: {
          agentId: "a1",
          name: "helper",
          task: "summarize",
          status: "running",
          progress: "working…",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    ]);
    expect(live).toHaveLength(1);
    expect(live[0]?.blocks[0]).toMatchObject({
      kind: "subagent",
      name: "helper",
      status: "running",
    });

    const durable = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "thread.subagent",
        runId: "r1",
        payload: {
          agentId: "a1",
          name: "helper",
          task: "summarize",
          status: "running",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "thread.message.created",
        runId: "r1",
        payload: {
          messageId: "m1",
          role: "bot",
          blocks: [
            {
              kind: "subagent",
              agentId: "a1",
              name: "helper",
              task: "summarize",
              status: "completed",
              result: "ok",
            },
          ],
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ]);
    expect(durable).toHaveLength(1);
    expect(durable[0]?.blocks[0]).toMatchObject({ status: "completed", result: "ok" });
  });
});

describe("threadEventNeedsSnapshotRefresh", () => {
  it("skips a full reload for events the live feed already applies", () => {
    expect(threadEventNeedsSnapshotRefresh("thread.message.created")).toBe(false);
    expect(threadEventNeedsSnapshotRefresh("thread.progress")).toBe(false);
    expect(threadEventNeedsSnapshotRefresh("computer.status")).toBe(false);
    expect(threadEventNeedsSnapshotRefresh("computer.takeover.granted")).toBe(false);
    expect(threadEventNeedsSnapshotRefresh("run.started")).toBe(false);
  });

  it("asks for a snapshot after a run ends or a child bot appears", () => {
    expect(threadEventNeedsSnapshotRefresh("run.completed")).toBe(true);
    expect(threadEventNeedsSnapshotRefresh("run.failed")).toBe(true);
    expect(threadEventNeedsSnapshotRefresh("run.cancelled")).toBe(true);
    expect(threadEventNeedsSnapshotRefresh("bot.spawned")).toBe(true);
    expect(threadEventNeedsSnapshotRefresh("thread.cleared")).toBe(true);
  });
});
