import type { WakeupJob } from "@quibt/adapter-kit";
import type { PrismaClient } from "@quibt/db";
import { describe, expect, it, vi } from "vitest";
import { ApprovalPause } from "./approval-wait.js";
import {
  PEER_WAIT_TIMEOUT_MS,
  PeerPause,
  parsePeerCheckpoint,
  peerAnswerNote,
  peerCheckpoint,
  peerWaitJobKey,
  peerWaitMarker,
  resolvePeerAnswer,
  wakeRunsWaitingForPeer,
} from "./peer-wait.js";

function pending(overrides: Partial<Parameters<typeof peerCheckpoint>[0]> = {}) {
  return {
    peerRunId: "run-peer",
    botId: "bot-2",
    botName: "Scout",
    question: "onde fica o evento?",
    executionId: "exec-1",
    deadlineAt: new Date(Date.now() + PEER_WAIT_TIMEOUT_MS).toISOString(),
    ...overrides,
  };
}

describe("peer wait checkpoint", () => {
  it("round-trips and stays findable by the marker used to wake the asker", () => {
    const raw = peerCheckpoint(pending());
    expect(raw).toContain(peerWaitMarker("run-peer"));
    expect(parsePeerCheckpoint(raw)).toMatchObject({ peerRunId: "run-peer", botName: "Scout" });
  });

  it("ignores an approval checkpoint and malformed json", () => {
    expect(
      parsePeerCheckpoint(JSON.stringify({ pendingApproval: { tool: "shell" } })),
    ).toBeUndefined();
    expect(parsePeerCheckpoint("not json")).toBeUndefined();
    expect(parsePeerCheckpoint(null)).toBeUndefined();
  });

  it("keys the timeout wake per run", () => {
    expect(peerWaitJobKey("run-1")).toBe("peer-wait:run-1");
  });

  it("unwinds the turn through the same pause path as an approval", () => {
    expect(new PeerPause()).toBeInstanceOf(ApprovalPause);
  });
});

function prismaWith(run: { status: string } | null, text?: string) {
  const mock = {
    run: { findUnique: vi.fn(async () => run) },
    message: {
      findFirst: vi.fn(async () =>
        text === undefined ? null : { blocks: [{ kind: "text", text }] },
      ),
    },
  };
  return mock as unknown as PrismaClient;
}

describe("resolvePeerAnswer", () => {
  it("returns the teammate's last message once its run is done", async () => {
    const answer = await resolvePeerAnswer(
      prismaWith({ status: "completed" }, "é no centro"),
      pending(),
    );
    expect(answer).toEqual({ state: "answered", text: "é no centro", status: "completed" });
  });

  it("reports a teammate blocked on the user", async () => {
    const answer = await resolvePeerAnswer(prismaWith({ status: "waiting_input" }), pending());
    expect(answer).toEqual({ state: "waiting", status: "waiting_input" });
  });

  it("keeps waiting while the teammate is still running", async () => {
    const answer = await resolvePeerAnswer(prismaWith({ status: "running" }), pending());
    expect(answer).toEqual({ state: "pending" });
  });

  it("gives up once the deadline passed", async () => {
    const answer = await resolvePeerAnswer(
      prismaWith({ status: "running" }),
      pending({ deadlineAt: new Date(Date.now() - 1).toISOString() }),
    );
    expect(answer).toEqual({ state: "timeout" });
  });
});

describe("peerAnswerNote", () => {
  it("tells the model not to ask the same teammate again", () => {
    const note = peerAnswerNote(pending(), { state: "answered", text: "sim", status: "completed" });
    expect(note).toContain("Scout answered");
    expect(note).toContain("sim");
    expect(note).toContain("Do not ask the same teammate again");
  });

  it("says the teammate never answered on timeout", () => {
    expect(peerAnswerNote(pending(), { state: "timeout" })).toContain("did not answer in time");
  });
});

describe("wakeRunsWaitingForPeer", () => {
  it("continues every run parked on the finished teammate run", async () => {
    const enqueued: Array<Record<string, unknown>> = [];
    const prisma = {
      run: {
        findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          expect(where).toMatchObject({
            status: "waiting_input",
            checkpoint: { contains: peerWaitMarker("run-peer") },
          });
          return [{ id: "run-asker" }];
        }),
      },
    } as unknown as PrismaClient;
    const wakeup = {
      describe: () => ({
        id: "f",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: { cron: true, delay: true },
      }),
      enqueue: vi.fn(async (job: WakeupJob) => {
        enqueued.push(job as unknown as Record<string, unknown>);
      }),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    expect(await wakeRunsWaitingForPeer({ prisma, wakeup }, "run-peer")).toEqual(["run-asker"]);
    expect(enqueued).toEqual([{ name: "run.continue", payload: { runId: "run-asker" } }]);
  });

  it("does nothing without a wakeup driver", async () => {
    const prisma = { run: { findMany: vi.fn() } } as unknown as PrismaClient;
    expect(await wakeRunsWaitingForPeer({ prisma }, "run-peer")).toEqual([]);
  });
});
